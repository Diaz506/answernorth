import test from 'node:test';
import assert from 'node:assert/strict';
import { NotebookJobClient } from '../dist/notebook-job-client.js';
import { NotebookJobCoordinator } from '../dist/notebook-job-coordinator.js';
import { RunLedger } from '../dist/runs.js';
import { prepareRun } from '../dist/run-preparation.js';
import { safeResult } from '../dist/safety.js';
import { Suites } from '../dist/suites.js';

const TENANT = 'a0a00001-1234-4abc-8def-000000000001';
const OWNER = 'a0a00002-1234-4abc-8def-000000000002';
const WORKSPACE = 'a0a00003-1234-4abc-8def-000000000003';
const AGENT = 'a0a00004-1234-4abc-8def-000000000004';
const REQUEST = 'a0a00005-1234-4abc-8def-000000000005';
const APP = 'a0a00006-1234-4abc-8def-000000000006';
const NOTEBOOK = 'a0a00007-1234-4abc-8def-000000000007';
const JOB = 'a0a00008-1234-4abc-8def-000000000008';
const GUARD_KEY = Buffer.alloc(32, 7);
const deployment = { tenantId: TENANT, workspaceId: WORKSPACE, appId: APP, ownerId: OWNER };
const execution = { workspaceId: WORKSPACE, notebookId: NOTEBOOK };
const token = claims => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
  tid: TENANT, oid: OWNER, aud: 'https://api.fabric.microsoft.com', ...claims })).toString('base64url')}.signature`;
const initialTime = Date.parse('2026-01-02T03:04:05.000Z');
const location = `https://api.fabric.microsoft.com/v1/workspaces/${WORKSPACE}/items/${NOTEBOOK}/jobs/instances/${JOB}`;
const accepted = () => new Response(null, { status: 202, headers: { location, 'retry-after': '60' } });
const emptyHistory = () => new Response(JSON.stringify({ value: [] }), { status: 200 });
const status = (state = 'Completed') => new Response(JSON.stringify({
  id: JOB, itemId: NOTEBOOK, jobType: 'RunNotebook', invokeType: 'OnDemand', status: state, failureReason: null,
}), { status: 200, headers: { 'content-type': 'application/json', 'retry-after': '90' } });

function fixture() {
  const rows = new Map(), writes = [];
  const store = {
    async manifests(owner, family) { return { items: [...rows.values()].filter(row => row.owner_id === owner &&
      row.kind === 'manifest' && (!family || row.suiteId === family)), hasNextPage: false }; },
    async runs(owner) { return { items: [...rows.values()].filter(row => row.owner_id === owner && row.kind === 'run'), hasNextPage: false }; },
    async guardPage(owner, scopeId, kind, cursor) {
      const items = [...rows.values()].filter(row => row.owner_id === owner && row.kind === kind && row.suiteId === scopeId);
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

async function setup(store) {
  const suite = await new Suites(store, OWNER).save(JSON.stringify({
    name: 'Synthetic suite', cases: [{ question: 'What is two plus two?', expectedAnswer: 'Four.', category: '', critical: true }],
  }));
  const selection = { workspaceId: WORKSPACE, agentId: AGENT, suiteId: suite.id, stage: 'sandbox' };
  const agent = { id: AGENT, name: 'Synthetic agent', workspaceId: WORKSPACE, workspaceName: 'Synthetic workspace' };
  const preparation = prepareRun(selection, agent, suite);
  const ledger = new RunLedger(store, OWNER);
  const draft = await ledger.create(REQUEST, preparation);
  return { ledger, draft, preparation };
}

test('one approved claim produces one POST and a durable receipt; job completion remains unverified', async () => {
  const { rows, store } = fixture();
  const { ledger, draft, preparation } = await setup(store);
  const calls = [];
  let now = initialTime;
  const request = async (url, options) => {
    calls.push({ url, options });
    return options.method === 'POST' ? accepted()
      : new URL(url).pathname.endsWith('/jobs/instances') ? emptyHistory() : status();
  };
  const client = new NotebookJobClient(token(), deployment, execution, request, () => now);
  const coordinator = new NotebookJobCoordinator(store, OWNER, client, GUARD_KEY, async () => preparation);
  await assert.rejects(() => coordinator.submitOnce(draft.id, draft.approvalDigest), error => error.code === 'APPROVAL_REQUIRED');
  assert.equal(calls.length, 0);
  await ledger.approve(draft.id, draft.approvalDigest, preparation);
  const results = await Promise.allSettled([
    coordinator.submitOnce(draft.id, draft.approvalDigest),
    coordinator.submitOnce(draft.id, draft.approvalDigest),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const run = await ledger.get(draft.id);
  assert.equal(run.status, 'job_accepted');
  assert.equal(run.job.jobId, JOB);
  assert.equal(run.job.firstPollAfterSeconds, 60);
  assert.equal([...rows.values()].filter(row => row.kind === 'run_claim').length, 1);
  assert.equal([...rows.values()].filter(row => row.kind === 'run_receipt').length, 1);
  const submissions = calls.filter(call => call.options.method === 'POST');
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].options.redirect, 'error');
  assert.ok(submissions[0].url.startsWith('https://api.fabric.microsoft.com/'));
  const body = JSON.parse(submissions[0].options.body);
  assert.deepEqual(body.parameters.map(item => [item.name, item.type]), [['run_id', 'Guid'], ['attempt_id', 'Guid']]);
  assert.ok(!submissions[0].options.body.includes('What is two plus two?'));
  const beforePoll = calls.length;
  await assert.rejects(() => client.observe(run.job), error => error.code === 'JOB_POLL_TOO_EARLY');
  assert.equal(calls.length, beforePoll);
  now += 60_000;
  const observation = await client.observe(run.job);
  assert.deepEqual(observation, { state: 'job_completed_unverified', checkedAt: new Date(now).toISOString(), nextPollAfterSeconds: 90 });
  assert.equal(calls.length, beforePoll + 1);
  assert.equal(calls.at(-1).options.method, 'GET');
});

test('ambiguous submissions never retry and leave the durable claim uncertain', async () => {
  for (const response of [
    () => new Response(null, { status: 429 }),
    () => new Response(null, { status: 500 }),
    () => new Response(null, { status: 202 }),
    () => { throw new Error('private provider details'); },
  ]) {
    const { store } = fixture();
    const { ledger, draft, preparation } = await setup(store);
    await ledger.approve(draft.id, draft.approvalDigest, preparation);
    let calls = 0;
    const client = new NotebookJobClient(token(), deployment, execution, async (_url, options) => {
      if (options.method === 'GET') return emptyHistory();
      calls++; return response();
    }, () => initialTime);
    const coordinator = new NotebookJobCoordinator(store, OWNER, client, GUARD_KEY, async () => preparation);
    await assert.rejects(() => coordinator.submitOnce(draft.id, draft.approvalDigest),
      error => error.code === 'JOB_SUBMISSION_UNCERTAIN' && !error.message.includes('private'));
    assert.equal((await ledger.get(draft.id)).status, 'submission_uncertain');
    await assert.rejects(() => coordinator.submitOnce(draft.id, draft.approvalDigest), error => error.code === 'RUN_ALREADY_CLAIMED');
    assert.equal(calls, 1);
  }
});

test('a stale target is rejected before the claim and before any POST', async () => {
  const { store, writes } = fixture();
  const { ledger, draft, preparation } = await setup(store);
  await ledger.approve(draft.id, draft.approvalDigest, preparation);
  let calls = 0;
  const client = new NotebookJobClient(token(), deployment, execution, async () => { calls++; return accepted(); }, () => initialTime);
  const coordinator = new NotebookJobCoordinator(store, OWNER, client, GUARD_KEY, async () =>
    ({ ...preparation, target: { ...preparation.target, name: 'Changed agent' } }));
  await assert.rejects(() => coordinator.submitOnce(draft.id, draft.approvalDigest), error => error.code === 'RUN_STALE');
  assert.equal(calls, 0);
  assert.equal(writes.filter(kind => kind === 'run_claim').length, 0);
});

test('recent or active notebook jobs block submission before the claim', async () => {
  for (const [jobStatus, start] of [
    ['InProgress', null],
    ['NotStarted', null],
    ['Completed', new Date(initialTime - 300_000).toISOString()],
    ['Failed', new Date(initialTime + 1_000).toISOString()],
  ]) {
    const { store, writes } = fixture();
    const { ledger, draft, preparation } = await setup(store);
    await ledger.approve(draft.id, draft.approvalDigest, preparation);
    const calls = [];
    const client = new NotebookJobClient(token(), deployment, execution, async (_url, options) => {
      calls.push(options.method);
      return new Response(JSON.stringify({ value: [{ id: JOB, itemId: NOTEBOOK, jobType: 'RunNotebook',
        status: jobStatus, startTimeUtc: start }] }), { status: 200 });
    }, () => initialTime);
    const coordinator = new NotebookJobCoordinator(store, OWNER, client, GUARD_KEY, async () => preparation);
    await assert.rejects(() => coordinator.submitOnce(draft.id, draft.approvalDigest), error => error.code === 'JOB_RECENT_OR_ACTIVE');
    assert.deepEqual(calls, ['GET']);
    assert.equal(writes.filter(kind => kind === 'run_claim').length, 0);
    assert.equal((await ledger.get(draft.id)).status, 'approved');
  }
});

test('a post-lock precheck failure leaves the guard held and never posts a job', async () => {
  const { rows, store } = fixture();
  const { ledger, draft, preparation } = await setup(store);
  await ledger.approve(draft.id, draft.approvalDigest, preparation);
  let gets = 0, posts = 0;
  const worker = new NotebookJobClient(token(), deployment, execution, async (_url, options) => {
    if (options.method === 'POST') { posts++; return accepted(); }
    gets++;
    return gets === 1 ? emptyHistory() : new Response(null, { status: 429, headers: { 'retry-after': '90' } });
  }, () => initialTime);
  const coordinator = new NotebookJobCoordinator(store, OWNER, worker, GUARD_KEY, async () => preparation);
  await assert.rejects(() => coordinator.submitOnce(draft.id, draft.approvalDigest),
    error => error.code === 'GUARD_HELD_RECONCILE' && error.retryAfterSeconds === 90);
  assert.equal(posts, 0);
  assert.equal((await ledger.get(draft.id)).status, 'approved');
  assert.equal([...rows.values()].filter(row => row.kind === 'notebook_guard').length, 1);
});

test('preflight checks all pages, accepts older jobs and rejects ambiguous history', async () => {
  const old = { id: JOB, itemId: NOTEBOOK, jobType: 'RunNotebook', status: 'Completed',
    startTimeUtc: '2026-01-02T02:50:00.1234567' };
  const calls = [];
  const paged = new NotebookJobClient(token(), deployment, execution, async url => {
    calls.push(url);
    return new Response(JSON.stringify(calls.length === 1 ? { value: [old], continuationToken: 'next-page' } : { value: [] }), { status: 200 });
  }, () => initialTime);
  await paged.assertNoRecentJobs();
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1]).searchParams.get('continuationToken'), 'next-page');
  const found = new NotebookJobClient(token(), deployment, execution,
    async () => new Response(JSON.stringify({ value: [old] }), { status: 200 }), () => initialTime);
  await found.assertNoRecentJobs(JOB);
  await assert.rejects(() => found.assertNoRecentJobs(AGENT), error => error.code === 'JOB_PRECHECK_INCOMPLETE');
  for (const body of [
    { value: [{ ...old, status: 'Unknown' }] },
    { value: [{ ...old, itemId: AGENT }] },
    { value: [{ ...old, startTimeUtc: '2026-02-30T00:00:00Z' }] },
    { value: [old, old] },
    { value: [], continuationToken: {} },
  ]) {
    const client = new NotebookJobClient(token(), deployment, execution,
      async () => new Response(JSON.stringify(body), { status: 200 }), () => initialTime);
    await assert.rejects(() => client.assertNoRecentJobs(), error => error.code === 'JOB_PRECHECK_INVALID');
  }
  const duplicateKey = `{"value":[{"id":"${JOB}","itemId":"${NOTEBOOK}","jobType":"RunNotebook","status":"Completed","status":"Failed","startTimeUtc":"2026-01-02T02:50:00Z"}]}`;
  const malformed = new NotebookJobClient(token(), deployment, execution,
    async () => new Response(duplicateKey, { status: 200 }), () => initialTime);
  await assert.rejects(() => malformed.assertNoRecentJobs(), error => error.code === 'JOB_STATUS_INVALID');
  let page = 0;
  const incomplete = new NotebookJobClient(token(), deployment, execution,
    async () => new Response(JSON.stringify({ value: [], continuationToken: `page-${++page}` }), { status: 200 }), () => initialTime);
  await assert.rejects(() => incomplete.assertNoRecentJobs(), error => error.code === 'JOB_PRECHECK_INCOMPLETE');
  assert.equal(page, 10);
  const throttled = new NotebookJobClient(token(), deployment, execution,
    async () => new Response(null, { status: 429, headers: { 'retry-after': '90' } }), () => initialTime);
  await assert.rejects(() => throttled.assertNoRecentJobs(),
    error => error.code === 'JOB_PRECHECK_THROTTLED' && error.retryAfterSeconds === 90);
});

test('status reads enforce the configured target and safely surface provider throttling', async () => {
  const receipt = { workspaceId: WORKSPACE, notebookId: NOTEBOOK, jobId: JOB,
    acceptedAt: new Date(initialTime).toISOString(), firstPollAfterSeconds: 0 };
  let calls = 0;
  const client = new NotebookJobClient(token(), deployment, execution, async () => {
    calls++; return new Response('private provider detail', { status: 429, headers: { 'retry-after': '75' } });
  }, () => initialTime);
  await assert.rejects(() => client.observe({ ...receipt, notebookId: AGENT }), error => error.code === 'JOB_RECEIPT_INVALID');
  assert.equal(calls, 0);
  const envelope = JSON.parse(await safeResult(() => client.observe(receipt)));
  assert.deepEqual(envelope, { error: { code: 'JOB_THROTTLED',
    message: 'The notebook job status is unavailable. No retry was performed.', retryAfterSeconds: 75 } });
  assert.equal(calls, 1);
  for (const header of [undefined, 'not-a-delay']) {
    const noDelay = new NotebookJobClient(token(), deployment, execution, async () =>
      new Response(null, { status: 429, headers: header ? { 'retry-after': header } : {} }), () => initialTime);
    const result = JSON.parse(await safeResult(() => noDelay.observe(receipt)));
    assert.equal(result.error.code, 'JOB_THROTTLED');
    assert.equal(result.error.retryAfterSeconds, undefined);
  }
});

test('status responses reject malformed, oversized, duplicate-key and unexpected provider data', async () => {
  const receipt = { workspaceId: WORKSPACE, notebookId: NOTEBOOK, jobId: JOB,
    acceptedAt: new Date(initialTime).toISOString(), firstPollAfterSeconds: 0 };
  const base = JSON.stringify({ id: JOB, itemId: NOTEBOOK, jobType: 'RunNotebook', invokeType: 'Manual', status: 'Completed' });
  const responses = [
    () => new Response('{', { status: 200 }),
    () => new Response(base.replace('"status":"Completed"', '"status":"Completed","status":"Failed"'), { status: 200 }),
    () => new Response(base, { status: 200, headers: { 'content-length': '1048577' } }),
    () => new Response('x'.repeat(1_048_577), { status: 200 }),
    () => new Response(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]), { status: 200 }),
    () => new Response('{"nested":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}', { status: 200 }),
    () => new Response(base, { status: 200, headers: { 'retry-after': 'bad' } }),
  ];
  for (const make of responses) {
    const client = new NotebookJobClient(token(), deployment, execution, async () => make(), () => initialTime);
    await assert.rejects(() => client.observe(receipt), error => error.code === 'JOB_STATUS_INVALID');
  }
});

test('submission timeout leaves exactly one attempted request and no automatic retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const client = new NotebookJobClient(token(), deployment, execution, async () => { calls++; return new Promise(() => {}); }, () => initialTime);
  const pending = client.submitOnce(APP, REQUEST);
  t.mock.timers.tick(30_001);
  await assert.rejects(() => pending, error => error.code === 'JOB_SUBMISSION_UNCERTAIN');
  assert.equal(calls, 1);
});

test('a late acceptance after timeout stays uncertain and does not create a false receipt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, writes } = fixture();
  const { ledger, draft, preparation } = await setup(store);
  await ledger.approve(draft.id, draft.approvalDigest, preparation);
  let releasePost, notifyPost;
  const postStarted = new Promise(resolve => { notifyPost = resolve; });
  let postCount = 0;
  const request = async (_url, options) => {
    if (options.method === 'GET') return emptyHistory();
    postCount++;
    notifyPost();
    return new Promise(resolve => { releasePost = resolve; });
  };
  const client = new NotebookJobClient(token(), deployment, execution, request, () => initialTime);
  const coordinator = new NotebookJobCoordinator(store, OWNER, client, GUARD_KEY, async () => preparation);
  const pending = coordinator.submitOnce(draft.id, draft.approvalDigest);
  await postStarted;
  t.mock.timers.tick(30_001);
  await assert.rejects(() => pending, error => error.code === 'JOB_SUBMISSION_UNCERTAIN');
  releasePost(accepted());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal((await ledger.get(draft.id)).status, 'submission_uncertain');
  assert.equal(writes.filter(kind => kind === 'run_receipt').length, 0);
  await assert.rejects(() => coordinator.submitOnce(draft.id, draft.approvalDigest), error => error.code === 'RUN_ALREADY_CLAIMED');
  assert.equal(postCount, 1);
});
