import test from 'node:test';
import assert from 'node:assert/strict';
import { publishWorkerManifest } from '../dist/onelake-manifest-publisher.js';
import { RunLedger, submissionClaimId } from '../dist/runs.js';
import { prepareRun } from '../dist/run-preparation.js';
import { Suites } from '../dist/suites.js';

const TENANT = 'a0a00001-1234-4abc-8def-000000000001';
const OWNER = 'a0a00002-1234-4abc-8def-000000000002';
const WORKSPACE = 'a0a00003-1234-4abc-8def-000000000003';
const AGENT = 'a0a00004-1234-4abc-8def-000000000004';
const REQUEST = 'a0a00005-1234-4abc-8def-000000000005';
const APP = 'a0a00006-1234-4abc-8def-000000000006';
const NOTEBOOK = 'a0a00007-1234-4abc-8def-000000000007';
const LAKEHOUSE = 'a0a00008-1234-4abc-8def-000000000008';
const OTHER = 'a0a00009-1234-4abc-8def-000000000009';
const KEY = Buffer.alloc(32, 7);
const ETAG = '"0x1234"';
const deployment = { tenantId: TENANT, workspaceId: WORKSPACE, appId: APP, ownerId: OWNER };
const execution = { workspaceId: WORKSPACE, notebookId: NOTEBOOK };
const location = { workspaceId: WORKSPACE, lakehouseId: LAKEHOUSE };
const agent = { id: AGENT, name: 'Synthetic agent', workspaceId: WORKSPACE, workspaceName: 'Synthetic workspace' };
const token = claims => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
  tid: TENANT, oid: OWNER, aud: 'https://storage.azure.com', ...claims })).toString('base64url')}.signature`;

async function setup({ claim = true } = {}) {
  const rows = new Map();
  const store = {
    async manifests(owner) { return { items: [...rows.values()].filter(row => row.owner_id === owner && row.kind === 'manifest'), hasNextPage: false }; },
    async record(owner, id) { const row = rows.get(id); return row?.owner_id === owner ? row : undefined; },
    async create(row) {
      if (rows.has(row.id)) throw new Error('conflicting synthetic write');
      rows.set(row.id, structuredClone(row));
    },
  };
  const suite = await new Suites(store, OWNER).save(JSON.stringify({
    name: 'Synthetic suite', cases: [{ question: 'Count \u{1f4ca}?', expectedAnswer: 'Four.', category: '', critical: true }],
  }));
  const preparation = prepareRun({ workspaceId: WORKSPACE, agentId: AGENT, suiteId: suite.id, stage: 'sandbox' }, agent, suite);
  const ledger = new RunLedger(store, OWNER);
  const run = await ledger.create(REQUEST, preparation);
  await ledger.approve(run.id, run.approvalDigest, preparation);
  if (claim) await ledger.claimSubmission(run.id, run.approvalDigest);
  const publish = (request, overrides = {}) => publishWorkerManifest(store,
    overrides.deployment ?? deployment, execution, overrides.location ?? location,
    overrides.key ?? KEY, overrides.token ?? token(), run.id, overrides.resolveAgent ?? (async () => agent), request);
  return { store, ledger, run, preparation, publish };
}

function fakeStorage() {
  const calls = [];
  let saved;
  const request = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'PUT') {
      if (saved) return new Response(null, { status: 412 });
      saved = Buffer.from(options.body);
      return new Response(null, { status: 201, headers: { etag: ETAG } });
    }
    return new Response(saved, { status: 200, headers: { etag: ETAG, 'content-length': String(saved.length) } });
  };
  return { request, calls };
}

test('one create-only PUT and a matching bounded readback use the fixed reader path', async () => {
  const { run, publish } = await setup();
  const storage = fakeStorage();
  assert.deepEqual(await publish(storage.request), { state: 'stored_unverified', etag: ETAG });
  assert.equal(storage.calls.length, 2);
  const [put, get] = storage.calls;
  assert.equal(put.url, `https://onelake.blob.fabric.microsoft.com/${WORKSPACE}/${LAKEHOUSE}` +
    `/Files/answernorth/manifests/${run.id}/${submissionClaimId(OWNER, run.id)}.json`);
  assert.equal(get.url, put.url);
  assert.equal(put.options.method, 'PUT');
  assert.equal(put.options.redirect, 'error');
  assert.equal(put.options.headers['If-None-Match'], '*');
  assert.equal(put.options.headers['x-ms-blob-type'], 'BlockBlob');
  assert.equal(put.options.headers['Content-Length'], String(put.options.body.byteLength));
  assert.equal(get.options.method, 'GET');
  assert.equal(get.options.redirect, 'error');
  assert.equal(get.options.headers['If-Match'], ETAG);
  assert.ok(!put.url.includes('synthetic-token'));
  const envelope = JSON.parse(put.options.body.toString('utf8'));
  const payload = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
  assert.equal(payload.binding.runId, run.id);
  assert.equal(payload.binding.attemptId, submissionClaimId(OWNER, run.id));
});

test('concurrent attempts cannot both succeed when the provider honors conditional creation', async () => {
  const { publish } = await setup();
  const storage = fakeStorage();
  const results = await Promise.allSettled([publish(storage.request), publish(storage.request)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'MANIFEST_CONFLICT').length, 1);
  assert.equal(storage.calls.filter(call => call.options.method === 'PUT').length, 2);
  assert.equal(storage.calls.filter(call => call.options.method === 'GET').length, 1);
});

test('OneLake BlobAlreadyExists is a conflict, while other 409 responses remain uncertain', async () => {
  for (const [providerCode, expected] of [['BlobAlreadyExists', 'MANIFEST_CONFLICT'],
    ['BlobImmutableDueToPolicy', 'MANIFEST_PUBLISH_UNCERTAIN'], ['', 'MANIFEST_PUBLISH_UNCERTAIN']]) {
    const { publish } = await setup();
    const calls = [];
    await assert.rejects(() => publish(async (_url, options) => {
      calls.push(options.method);
      return new Response(null, { status: 409, headers: providerCode ? { 'x-ms-error-code': providerCode } : {} });
    }), error => error.code === expected);
    assert.deepEqual(calls, ['PUT']);
  }
});

test('invalid owner, storage configuration, stale target and missing claim never make a request', async () => {
  const claimed = await setup();
  const unclaimed = await setup({ claim: false });
  let calls = 0;
  const request = async () => { calls++; throw new Error('unexpected'); };
  for (const [fixture, overrides] of [
    [claimed, { token: token({ oid: OTHER }) }],
    [claimed, { token: token({ aud: 'https://api.fabric.microsoft.com' }) }],
    [claimed, { location: { ...location, lakehouseId: 'invalid' } }],
    [claimed, { resolveAgent: async () => ({ ...agent, name: 'Changed agent' }) }],
    [unclaimed, {}],
  ]) await assert.rejects(() => fixture.publish(request, overrides));
  assert.equal(calls, 0);
});

test('unknown PUT outcomes and rejected headers never cause a retry or a readback', async () => {
  for (const outcome of [
    () => new Response(null, { status: 500 }),
    () => new Response(null, { status: 201 }),
    () => new Response(null, { status: 201, headers: { etag: ETAG, 'x-ms-rejected-headers': 'If-None-Match' } }),
    () => new Response(null, { status: 412, headers: { 'x-ms-rejected-headers': 'If-None-Match' } }),
    () => { throw new Error('sensitive provider text'); },
  ]) {
    const { publish } = await setup();
    const calls = [];
    await assert.rejects(() => publish(async (_url, options) => { calls.push(options.method); return outcome(); }),
      error => error.code === 'MANIFEST_PUBLISH_UNCERTAIN' && !error.message.includes('sensitive'));
    assert.deepEqual(calls, ['PUT']);
  }
});

test('mismatched or unavailable readbacks fail closed without retrying the write', async () => {
  const variants = [
    () => new Response(null, { status: 404 }),
    () => new Response('changed', { status: 200, headers: { etag: ETAG } }),
    body => new Response(body, { status: 200, headers: { etag: '"different"' } }),
    body => new Response(body, { status: 200, headers: { etag: ETAG, 'content-length': '1' } }),
    body => new Response(body, { status: 200, headers: { etag: ETAG, 'content-encoding': 'gzip' } }),
    body => new Response(body, { status: 200, headers: { etag: ETAG, 'x-ms-rejected-headers': 'If-Match' } }),
    () => new Response(null, { status: 200, headers: { etag: ETAG } }),
  ];
  for (const response of variants) {
    const { publish } = await setup();
    const calls = [];
    let written;
    await assert.rejects(() => publish(async (_url, options) => {
      calls.push(options.method);
      if (options.method === 'PUT') {
        written = options.body;
        return new Response(null, { status: 201, headers: { etag: ETAG } });
      }
      return response(written);
    }), error => error.code === 'MANIFEST_PUBLISH_UNCERTAIN');
    assert.deepEqual(calls, ['PUT', 'GET']);
  }
});

test('a late successful PUT after timeout does not trigger a readback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { publish } = await setup();
  const calls = [];
  let complete, signal;
  const pending = publish(async (_url, options) => {
    calls.push(options.method);
    signal = options.signal;
    return new Promise(resolve => { complete = resolve; });
  });
  while (!complete) await Promise.resolve();
  t.mock.timers.tick(30_001);
  await assert.rejects(() => pending, error => error.code === 'MANIFEST_PUBLISH_UNCERTAIN');
  assert.equal(signal.aborted, true);
  complete(new Response(null, { status: 201, headers: { etag: ETAG } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['PUT']);
});

test('a late preparation after timeout cannot start a storage write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { publish } = await setup();
  const calls = [];
  let complete;
  const pending = publish(async (_url, options) => {
    calls.push(options.method);
    throw new Error('unexpected network call');
  }, { resolveAgent: () => new Promise(resolve => { complete = resolve; }) });
  while (!complete) await Promise.resolve();
  t.mock.timers.tick(30_001);
  await assert.rejects(() => pending, error => error.code === 'MANIFEST_PREPARATION_TIMEOUT');
  complete(agent);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
});
