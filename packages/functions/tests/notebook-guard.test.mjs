import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NotebookGuard } from '../dist/notebook-guard.js';
import { NotebookJobClient } from '../dist/notebook-job-client.js';
import { NotebookJobCoordinator } from '../dist/notebook-job-coordinator.js';
import { RunLedger } from '../dist/runs.js';
import { prepareRun } from '../dist/run-preparation.js';
import { jobGuardKey, stableId } from '../dist/safety.js';
import { Suites } from '../dist/suites.js';

const TENANT = 'a0a00001-1234-4abc-8def-000000000001';
const OWNER = 'a0a00002-1234-4abc-8def-000000000002';
const OTHER = 'a0a00003-1234-4abc-8def-000000000003';
const WORKSPACE = 'a0a00004-1234-4abc-8def-000000000004';
const AGENT = 'a0a00005-1234-4abc-8def-000000000005';
const APP = 'a0a00006-1234-4abc-8def-000000000006';
const NOTEBOOK = 'a0a00007-1234-4abc-8def-000000000007';
const JOB = 'a0a00008-1234-4abc-8def-000000000008';
const REQUEST_A = 'a0a00009-1234-4abc-8def-000000000009';
const REQUEST_B = 'a0a00010-1234-4abc-8def-000000000010';
const REQUEST_C = 'a0a00011-1234-4abc-8def-000000000011';
const KEY = Buffer.alloc(32, 7);
const clock = Date.parse('2026-01-02T03:04:05.000Z');
const deployment = { tenantId: TENANT, workspaceId: WORKSPACE, appId: APP, ownerId: OWNER };
const execution = { workspaceId: WORKSPACE, notebookId: NOTEBOOK };
const token = owner => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
  tid: TENANT, oid: owner, aud: 'https://api.fabric.microsoft.com' })).toString('base64url')}.signature`;
const receipt = { workspaceId: WORKSPACE, notebookId: NOTEBOOK, jobId: JOB,
  acceptedAt: '2026-01-02T02:50:00.000Z', firstPollAfterSeconds: 0 };

function fixture() {
  const rows = new Map(), writes = [];
  const store = {
    async manifests(owner, family) { return { items: [...rows.values()].filter(row => row.owner_id === owner &&
      row.kind === 'manifest' && (!family || row.suiteId === family)), hasNextPage: false }; },
    async runs(owner) { return { items: [...rows.values()].filter(row => row.owner_id === owner && row.kind === 'run'), hasNextPage: false }; },
    async guardPage(owner, scopeId, kind, cursor) {
      const items = [...rows.values()].filter(row => row.owner_id === owner && row.suiteId === scopeId && row.kind === kind);
      const offset = cursor ? Number(cursor) : 0;
      return { items: items.slice(offset, offset + 100), hasNextPage: offset + 100 < items.length,
        ...(offset + 100 < items.length ? { endCursor: String(offset + 100) } : {}) };
    },
    async record(owner, id) { const row = rows.get(id); return row?.owner_id === owner ? row : undefined; },
    async create(row) {
      writes.push(row.kind);
      if (rows.has(row.id)) throw new Error('conflicting synthetic write');
      rows.set(row.id, structuredClone(row));
    },
  };
  return { rows, writes, store };
}

function client(request, owner = OWNER, notebook = NOTEBOOK, now = () => clock) {
  return new NotebookJobClient(token(owner), { ...deployment, ownerId: owner },
    { ...execution, notebookId: notebook }, request, now);
}

async function setup(store, owner = OWNER) {
  const suite = await new Suites(store, owner).save(JSON.stringify({
    name: 'Synthetic suite', cases: [{ question: 'What is two plus two?', expectedAnswer: 'Four.', category: '', critical: true }],
  }));
  const selection = { workspaceId: WORKSPACE, agentId: AGENT, suiteId: suite.id, stage: 'sandbox' };
  const agent = { id: AGENT, name: 'Synthetic agent', workspaceId: WORKSPACE, workspaceName: 'Synthetic workspace' };
  const preparation = prepareRun(selection, agent, suite);
  const ledger = new RunLedger(store, owner);
  const first = await ledger.create(REQUEST_A, preparation);
  const second = await ledger.create(REQUEST_B, preparation);
  await ledger.approve(first.id, first.approvalDigest, preparation);
  await ledger.approve(second.id, second.approvalDigest, preparation);
  return { preparation, ledger, first, second };
}

function finishedRequest() {
  return async url => new URL(url).pathname.endsWith('/jobs/instances')
    ? new Response(JSON.stringify({ value: [{ id: JOB, itemId: NOTEBOOK, jobType: 'RunNotebook',
      status: 'Completed', startTimeUtc: '2026-01-02T02:50:00.000Z' }] }), { status: 200 })
    : new Response(JSON.stringify({ id: JOB, itemId: NOTEBOOK, jobType: 'RunNotebook',
      invokeType: 'Manual', status: 'Completed', failureReason: null }), { status: 200 });
}

test('two approved runs for the same notebook can acquire only one shared guard', async () => {
  const { rows, store } = fixture();
  const { first, second } = await setup(store);
  const worker = client(async () => { throw new Error('unexpected network call'); });
  const a = new NotebookGuard(store, OWNER, worker, KEY);
  const b = new NotebookGuard(store, OWNER, worker, KEY);
  const results = await Promise.allSettled([a.acquire(first.id, first.approvalDigest), b.acquire(second.id, second.approvalDigest)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const saved = [...rows.values()].filter(row => row.kind === 'notebook_guard');
  assert.equal(saved.length, 1);
  assert.ok(!saved[0].payload.includes(KEY.toString('base64url')));
});

test('two different run submissions cannot both POST for the same app-scoped notebook', async () => {
  const { rows, store } = fixture();
  const { first, second, preparation } = await setup(store);
  let posts = 0;
  const worker = client(async (url, options) => {
    if (options.method === 'GET') return new Response(JSON.stringify({ value: [] }), { status: 200 });
    posts++;
    return new Response(null, { status: 202, headers: {
      location: `https://api.fabric.microsoft.com/v1/workspaces/${WORKSPACE}/items/${NOTEBOOK}/jobs/instances/${JOB}`,
      'retry-after': '60',
    } });
  });
  const a = new NotebookJobCoordinator(store, OWNER, worker, KEY, async () => preparation);
  const b = new NotebookJobCoordinator(store, OWNER, worker, KEY, async () => preparation);
  const results = await Promise.allSettled([a.submitOnce(first.id, first.approvalDigest), b.submitOnce(second.id, second.approvalDigest)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(posts, 1);
  assert.equal([...rows.values()].filter(row => row.kind === 'notebook_guard').length, 1);
});

test('a different notebook has a different scope, while owner changes fail closed', async () => {
  const { store } = fixture();
  const { first, second } = await setup(store);
  const firstGuard = new NotebookGuard(store, OWNER, client(async () => { throw new Error('network'); }), KEY);
  await firstGuard.acquire(first.id, first.approvalDigest);
  const otherNotebook = new NotebookGuard(store, OWNER, client(async () => { throw new Error('network'); }, OWNER, OTHER), KEY);
  assert.equal((await otherNotebook.acquire(second.id, second.approvalDigest)).generation, 0);

  const other = await setup(store, OTHER);
  const changedOwner = new NotebookGuard(store, OTHER, client(async () => { throw new Error('network'); }, OTHER), KEY);
  await assert.rejects(() => changedOwner.acquire(other.first.id, other.first.approvalDigest),
    error => error.code === 'GUARD_ACQUIRE_UNCERTAIN');
});

test('a guard does not expire automatically and unknown submission cannot release it', async () => {
  const { store } = fixture();
  const { ledger, first, second } = await setup(store);
  let now = clock;
  let calls = 0;
  const worker = client(async () => { calls++; throw new Error('unexpected'); }, OWNER, NOTEBOOK, () => now);
  const guard = new NotebookGuard(store, OWNER, worker, KEY);
  const lease = await guard.acquire(first.id, first.approvalDigest);
  await ledger.claimSubmission(first.id, first.approvalDigest);
  now += 366 * 24 * 60 * 60 * 1000;
  await assert.rejects(() => guard.acquire(second.id, second.approvalDigest), error => error.code === 'GUARD_BUSY');
  await assert.rejects(() => guard.releaseVerified(lease.id), error => error.code === 'GUARD_RELEASE_BLOCKED');
  assert.equal(calls, 0);
});

test('release requires a matching recorded terminal job and clear recent-job history', async () => {
  const { rows, store } = fixture();
  const { ledger, first, second } = await setup(store);
  const guard = new NotebookGuard(store, OWNER, client(finishedRequest()), KEY);
  const lease = await guard.acquire(first.id, first.approvalDigest);
  await ledger.claimSubmission(first.id, first.approvalDigest);
  await ledger.recordJobReceipt(first.id, first.approvalDigest, receipt);
  await guard.releaseVerified(lease.id);
  await guard.releaseVerified(lease.id);
  assert.equal([...rows.values()].filter(row => row.kind === 'notebook_guard_release').length, 1);
  assert.equal((await guard.acquire(second.id, second.approvalDigest)).generation, 1);
});

test('running, missing history, recent, failed checks or missing receipts leave the guard held', async () => {
  for (const mode of ['running', 'recent', 'unavailable', 'missing-receipt', 'missing-history']) {
    const { rows, store } = fixture();
    const { ledger, first, second } = await setup(store);
    const worker = client(async url => {
      if (mode === 'unavailable') throw new Error('private service error');
      if (new URL(url).pathname.endsWith('/jobs/instances')) {
        return new Response(JSON.stringify({ value: mode === 'recent' ? [{
          id: JOB, itemId: NOTEBOOK, jobType: 'RunNotebook', status: 'InProgress',
        }] : [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: JOB, itemId: NOTEBOOK, jobType: 'RunNotebook',
        invokeType: 'Manual', status: mode === 'running' ? 'InProgress' : 'Completed', failureReason: null }), { status: 200 });
    });
    const guard = new NotebookGuard(store, OWNER, worker, KEY);
    const lease = await guard.acquire(first.id, first.approvalDigest);
    await ledger.claimSubmission(first.id, first.approvalDigest);
    if (mode !== 'missing-receipt') await ledger.recordJobReceipt(first.id, first.approvalDigest, receipt);
    await assert.rejects(() => guard.releaseVerified(lease.id));
    assert.equal([...rows.values()].filter(row => row.kind === 'notebook_guard_release').length, 0);
    await assert.rejects(() => guard.acquire(second.id, second.approvalDigest), error => error.code === 'GUARD_BUSY');
  }
});

test('tampering, duplicate keys, forged releases and key rotation fail closed', async () => {
  for (const mode of ['lock', 'duplicate', 'release', 'key']) {
    const { rows, store } = fixture();
    const { first, second } = await setup(store);
    const worker = client(async () => { throw new Error('network'); });
    const guard = new NotebookGuard(store, OWNER, worker, KEY);
    const lease = await guard.acquire(first.id, first.approvalDigest);
    if (mode === 'lock') {
      const row = rows.get(lease.id), payload = JSON.parse(row.payload);
      payload.runId = second.id;
      row.payload = JSON.stringify(payload);
    } else if (mode === 'duplicate') {
      const row = rows.get(lease.id);
      row.payload = row.payload.replace('"generation":0', '"generation":0,"\\u0067eneration":0');
    } else if (mode === 'release') {
      const id = stableId(['answernorth-notebook-release-v1', lease.scopeId, lease.generation]);
      const time = new Date().toISOString();
      rows.set(id, { id, owner_id: OWNER, kind: 'notebook_guard_release', suiteId: lease.scopeId, createdAt: new Date(time),
        payload: JSON.stringify({ schemaVersion: 1, scopeId: lease.scopeId, generation: lease.generation,
          guardId: lease.id, runId: lease.runId, approvalDigest: lease.approvalDigest,
          jobId: JOB, jobState: 'job_completed_unverified', checkedAt: time, createdAt: time, mac: '0'.repeat(64) }) });
    }
    const verifier = mode === 'key' ? new NotebookGuard(store, OWNER, worker, Buffer.alloc(32, 8)) : guard;
    await assert.rejects(() => verifier.acquire(second.id, second.approvalDigest), error => error.code === 'GUARD_HISTORY_INVALID');
  }
});

test('lost guard acknowledgements and incomplete history never trigger a retry or submission', async () => {
  const { store, writes } = fixture();
  const { first, second } = await setup(store);
  const worker = client(async () => { throw new Error('network'); });
  const guard = new NotebookGuard(store, OWNER, worker, KEY);
  const create = store.create;
  store.create = async row => { await create(row); if (row.kind === 'notebook_guard') throw new Error('private provider text'); };
  await assert.rejects(() => guard.acquire(first.id, first.approvalDigest),
    error => error.code === 'GUARD_ACQUIRE_UNCERTAIN' && !error.message.includes('private'));
  assert.equal(writes.filter(kind => kind === 'notebook_guard').length, 1);
  await assert.rejects(() => guard.acquire(second.id, second.approvalDigest), error => error.code === 'GUARD_BUSY');

  store.guardPage = async () => ({ items: [], hasNextPage: true, endCursor: 'same-cursor' });
  await assert.rejects(() => guard.acquire(second.id, second.approvalDigest), error => error.code === 'GUARD_HISTORY_INVALID');
  let page = 0;
  store.guardPage = async () => ({ items: [], hasNextPage: true, endCursor: `page-${++page}` });
  await assert.rejects(() => guard.acquire(second.id, second.approvalDigest), error => error.code === 'GUARD_HISTORY_INCOMPLETE');
  assert.equal(page, 10);
});

test('a missing historical release blocks new guard generations', async () => {
  const { rows, store } = fixture();
  const { ledger, first, second, preparation } = await setup(store);
  const guard = new NotebookGuard(store, OWNER, client(finishedRequest()), KEY);
  const firstLease = await guard.acquire(first.id, first.approvalDigest);
  await ledger.claimSubmission(first.id, first.approvalDigest);
  await ledger.recordJobReceipt(first.id, first.approvalDigest, receipt);
  await guard.releaseVerified(firstLease.id);
  await guard.acquire(second.id, second.approvalDigest);
  const third = await ledger.create(REQUEST_C, preparation);
  await ledger.approve(third.id, third.approvalDigest, preparation);
  const release = [...rows.values()].find(row => row.kind === 'notebook_guard_release');
  rows.delete(release.id);
  await assert.rejects(() => guard.acquire(third.id, third.approvalDigest), error => error.code === 'GUARD_HISTORY_INVALID');
});

test('a timed-out lock write never permits an automatic duplicate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { rows, store } = fixture();
  const { first, second } = await setup(store);
  const guard = new NotebookGuard(store, OWNER, client(async () => { throw new Error('network'); }), KEY);
  const original = store.create;
  let releaseWrite, notifyWrite;
  const started = new Promise(resolve => { notifyWrite = resolve; });
  store.create = async row => {
    if (row.kind !== 'notebook_guard') return original(row);
    notifyWrite();
    return new Promise(resolve => { releaseWrite = async () => { await original(row); resolve(); }; });
  };
  const pending = guard.acquire(first.id, first.approvalDigest);
  await started;
  t.mock.timers.tick(30_001);
  await assert.rejects(() => pending, error => error.code === 'GUARD_ACQUIRE_UNCERTAIN');
  await releaseWrite();
  await Promise.resolve();
  assert.equal([...rows.values()].filter(row => row.kind === 'notebook_guard').length, 1);
  await assert.rejects(() => guard.acquire(second.id, second.approvalDigest), error => error.code === 'GUARD_BUSY');
});

test('guard keys require canonical 256-bit base64url and never expose values', () => {
  const value = KEY.toString('base64url');
  assert.deepEqual(jobGuardKey({ getSecret: () => value }), KEY);
  for (const bad of [undefined, '', 'secret', `${value}=`, 'x'.repeat(43), 123]) {
    assert.throws(() => jobGuardKey({ getSecret: () => bad }), error =>
      error.code === 'CONFIGURATION_ERROR' && (bad === '' || !error.message.includes(String(bad))));
  }
  assert.throws(() => jobGuardKey({ getSecret() { throw new Error('sensitive provider text'); } }), error =>
    error.code === 'CONFIGURATION_ERROR' && !error.message.includes('sensitive'));
});

test('the guard retains its own copy of the key', async () => {
  const { store } = fixture();
  const { first, second } = await setup(store);
  const key = Buffer.from(KEY);
  const worker = client(async () => { throw new Error('network'); });
  const guard = new NotebookGuard(store, OWNER, worker, key);
  key.fill(0);
  await guard.acquire(first.id, first.approvalDigest);
  await assert.rejects(() => guard.acquire(second.id, second.approvalDigest), error => error.code === 'GUARD_BUSY');
});

test('one thousand released generations reach the supported limit and fail closed', async () => {
  const { rows, store } = fixture();
  const { first } = await setup(store);
  const worker = client(async () => { throw new Error('network'); });
  const guard = new NotebookGuard(store, OWNER, worker, KEY);
  const scopeId = stableId(['answernorth-notebook-scope-v1', TENANT, WORKSPACE, NOTEBOOK]);
  const createdAt = '2026-01-02T03:04:05.000Z';
  const sign = values => createHmac('sha256', KEY).update(JSON.stringify(values)).digest('hex');
  for (let generation = 0; generation < 1000; generation++) {
    const id = stableId(['answernorth-notebook-guard-v1', scopeId, generation]);
    const releaseId = stableId(['answernorth-notebook-release-v1', scopeId, generation]);
    const lockMac = sign(['answernorth-notebook-guard-v1', OWNER, id, scopeId, generation,
      first.id, first.approvalDigest, createdAt]);
    const releaseMac = sign(['answernorth-notebook-release-v1', OWNER, scopeId, generation, id,
      first.id, first.approvalDigest, JOB, 'job_completed_unverified', createdAt, createdAt]);
    rows.set(id, { id, owner_id: OWNER, kind: 'notebook_guard', suiteId: scopeId, createdAt: new Date(createdAt),
      payload: JSON.stringify({ schemaVersion: 1, scopeId, generation, runId: first.id,
        approvalDigest: first.approvalDigest, createdAt, mac: lockMac }) });
    rows.set(releaseId, { id: releaseId, owner_id: OWNER, kind: 'notebook_guard_release', suiteId: scopeId,
      createdAt: new Date(createdAt), payload: JSON.stringify({ schemaVersion: 1, scopeId, generation,
        guardId: id, runId: first.id, approvalDigest: first.approvalDigest, jobId: JOB,
        jobState: 'job_completed_unverified', checkedAt: createdAt, createdAt, mac: releaseMac }) });
  }
  await assert.rejects(() => guard.acquire(first.id, first.approvalDigest),
    error => error.code === 'GUARD_HISTORY_INCOMPLETE');
  assert.equal([...rows.values()].filter(row => row.kind === 'notebook_guard').length, 1000);
});
