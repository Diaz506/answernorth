import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createWorkerManifest } from '../dist/worker-manifest.js';
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
const OTHER = 'a0a00008-1234-4abc-8def-000000000008';
const KEY = Buffer.alloc(32, 7);
const deployment = { tenantId: TENANT, workspaceId: WORKSPACE, appId: APP, ownerId: OWNER };
const execution = { workspaceId: WORKSPACE, notebookId: NOTEBOOK };
const agent = { id: AGENT, name: 'Synthetic agent', workspaceId: WORKSPACE, workspaceName: 'Synthetic workspace' };

function fixture() {
  const rows = new Map(), writes = [];
  const store = {
    async manifests(owner) { return { items: [...rows.values()].filter(row => row.owner_id === owner && row.kind === 'manifest'), hasNextPage: false }; },
    async record(owner, id) { const row = rows.get(id); return row?.owner_id === owner ? row : undefined; },
    async create(row) {
      if (rows.has(row.id)) throw new Error('conflicting synthetic write');
      writes.push(row.kind);
      rows.set(row.id, structuredClone(row));
    },
  };
  return { rows, writes, store };
}

async function setup(store) {
  const suite = await new Suites(store, OWNER).save(JSON.stringify({
    name: 'Synthetic suite', cases: [{ question: 'Count \u{1f4ca}?', expectedAnswer: 'Four.', category: '', critical: true }],
  }));
  const preparation = prepareRun({ workspaceId: WORKSPACE, agentId: AGENT, suiteId: suite.id, stage: 'sandbox' }, agent, suite);
  const ledger = new RunLedger(store, OWNER);
  const run = await ledger.create(REQUEST, preparation);
  return { suite, preparation, ledger, run };
}

const issue = (store, run, resolveAgent = async () => agent, config = deployment, key = KEY) =>
  createWorkerManifest(store, config, execution, key, run.id, resolveAgent);

test('only an approved claimed run produces a bound authenticated manifest without side effects', async () => {
  const { store, writes } = fixture();
  const { run, preparation, ledger } = await setup(store);
  await assert.rejects(() => issue(store, run), error => error.code === 'CLAIM_REQUIRED');
  await ledger.approve(run.id, run.approvalDigest, preparation);
  await assert.rejects(() => issue(store, run), error => error.code === 'CLAIM_REQUIRED');
  await ledger.claimSubmission(run.id, run.approvalDigest);
  const writeCount = writes.length;
  const envelope = JSON.parse(await issue(store, run));
  assert.deepEqual(Object.keys(envelope).sort(), ['mac', 'payload', 'schemaVersion']);
  const bytes = Buffer.from(envelope.payload, 'base64url');
  assert.equal(bytes.toString('base64url'), envelope.payload);
  assert.equal(envelope.mac, createHmac('sha256', KEY).update('answernorth-worker-manifest-v1\0').update(bytes).digest('hex'));
  const payload = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(payload.binding, {
    tenantId: TENANT, appId: APP, ownerId: OWNER, runId: run.id,
    attemptId: submissionClaimId(OWNER, run.id), approvalDigest: run.approvalDigest,
    workerWorkspaceId: WORKSPACE, workerNotebookId: NOTEBOOK,
  });
  assert.deepEqual(payload.preparation, preparation);
  assert.equal(writes.length, writeCount);
  assert.equal((await ledger.get(run.id)).status, 'submission_uncertain');
});

test('stale or inaccessible agent, suite, owner, claim and configuration fail closed', async () => {
  const { rows, store } = fixture();
  const { run, preparation, ledger, suite } = await setup(store);
  await ledger.approve(run.id, run.approvalDigest, preparation);
  await ledger.claimSubmission(run.id, run.approvalDigest);
  await assert.rejects(() => issue(store, run, async () => ({ ...agent, name: 'Changed agent' })),
    error => error.code === 'RUN_STALE');
  await assert.rejects(() => issue(store, run, async () => ({ ...agent, id: OTHER })),
    error => error.code === 'INVALID_SCOPE');
  await assert.rejects(() => issue(store, run, async () => agent, { ...deployment, ownerId: OTHER }),
    error => error.code === 'RUN_NOT_FOUND');
  await assert.rejects(() => issue(store, run, async () => agent, deployment, Buffer.alloc(31)),
    error => error.code === 'CONFIGURATION_ERROR');
  await assert.rejects(() => issue(store, run, async () => agent, { ...deployment, appId: APP.toUpperCase() }),
    error => error.code === 'CONFIGURATION_ERROR');
  await assert.rejects(() => issue(store, run, async () => agent, { ...deployment, tenantId: 'not-an-id' }),
    error => error.code === 'CONFIGURATION_ERROR');
  const caseRow = rows.get(suite.cases[0].id);
  caseRow.payload = `${caseRow.payload}x`;
  await assert.rejects(() => issue(store, run), error => error.code === 'STORED_SUITE_INVALID');
});

test('a recorded receipt prevents issuing another offline manifest', async () => {
  const { store } = fixture();
  const { run, preparation, ledger } = await setup(store);
  await ledger.approve(run.id, run.approvalDigest, preparation);
  await ledger.claimSubmission(run.id, run.approvalDigest);
  await ledger.recordJobReceipt(run.id, run.approvalDigest, {
    workspaceId: WORKSPACE, notebookId: NOTEBOOK, jobId: OTHER,
    acceptedAt: '2026-01-02T03:04:05.000Z', firstPollAfterSeconds: 0,
  });
  await assert.rejects(() => issue(store, run), error => error.code === 'CLAIM_REQUIRED');
});

test('a receipt recorded during target resolution stops manifest creation', async () => {
  const { store } = fixture();
  const { run, preparation, ledger } = await setup(store);
  await ledger.approve(run.id, run.approvalDigest, preparation);
  await ledger.claimSubmission(run.id, run.approvalDigest);
  await assert.rejects(() => issue(store, run, async () => {
    await ledger.recordJobReceipt(run.id, run.approvalDigest, {
      workspaceId: WORKSPACE, notebookId: NOTEBOOK, jobId: OTHER,
      acceptedAt: '2026-01-02T03:04:05.000Z', firstPollAfterSeconds: 0,
    });
    return agent;
  }), error => error.code === 'CLAIM_REQUIRED');
});

test('a supplied key is copied before asynchronous resolution', async () => {
  const { store } = fixture();
  const { run, preparation, ledger } = await setup(store);
  await ledger.approve(run.id, run.approvalDigest, preparation);
  await ledger.claimSubmission(run.id, run.approvalDigest);
  const key = Buffer.from(KEY);
  const envelope = JSON.parse(await issue(store, run, async () => { key.fill(0); return agent; }, deployment, key));
  const bytes = Buffer.from(envelope.payload, 'base64url');
  assert.equal(envelope.mac, createHmac('sha256', KEY).update('answernorth-worker-manifest-v1\0').update(bytes).digest('hex'));
});
