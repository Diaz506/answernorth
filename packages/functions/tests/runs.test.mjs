import test from 'node:test';
import assert from 'node:assert/strict';
import { RunLedger } from '../dist/runs.js';
import { prepareRun } from '../dist/run-preparation.js';
import { Suites } from '../dist/suites.js';

const OWNER = 'a0a00001-1234-4abc-8def-000000000001';
const OTHER = 'a0a00002-1234-4abc-8def-000000000002';
const WORKSPACE = 'a0a00003-1234-4abc-8def-000000000003';
const AGENT = 'a0a00004-1234-4abc-8def-000000000004';
const REQUEST = 'a0a00005-1234-4abc-8def-000000000005';
const NOTEBOOK = 'a0a00006-1234-4abc-8def-000000000006';
const JOB = 'a0a00007-1234-4abc-8def-000000000007';
const receipt = { workspaceId: WORKSPACE, notebookId: NOTEBOOK, jobId: JOB,
  acceptedAt: '2026-01-02T03:04:05.000Z', firstPollAfterSeconds: 60 };

function fixture() {
  const rows = new Map(), writes = [];
  const store = {
    async manifests(owner, family) {
      return { items: [...rows.values()].filter(row => row.owner_id === owner && row.kind === 'manifest' &&
        (!family || row.suiteId === family)), hasNextPage: false };
    },
    async runs(owner) {
      const items = [...rows.values()].filter(row => row.owner_id === owner && row.kind === 'run');
      return { items: items.slice(0, 25), hasNextPage: items.length > 25 };
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

async function preparation(store) {
  const suite = await new Suites(store, OWNER).save(JSON.stringify({
    name: 'Synthetic suite',
    cases: [{ question: 'What is two plus two?', expectedAnswer: 'Four.', category: '', critical: true }],
  }));
  const selection = { workspaceId: WORKSPACE, agentId: AGENT, suiteId: suite.id, stage: 'production' };
  const target = { id: AGENT, name: 'Synthetic agent', workspaceId: WORKSPACE, workspaceName: 'Synthetic workspace' };
  return prepareRun(selection, target, suite);
}

test('durable draft is owner-scoped, bounded, and frozen to the selected suite and target', async () => {
  const { rows, store } = fixture();
  const prepared = await preparation(store);
  const ledger = new RunLedger(store, OWNER);
  const draft = await ledger.create(REQUEST, prepared);
  assert.equal(draft.status, 'awaiting_approval');
  assert.equal(draft.requestId, REQUEST);
  assert.equal(draft.suite.hash, prepared.suite.hash);
  assert.equal(draft.suite.caseCount, 1);
  assert.equal(draft.target.publicationVerified, false);
  assert.equal(draft.approvedAt, undefined);
  assert.deepEqual(await ledger.get(draft.id), draft);
  assert.deepEqual(await ledger.history(), { runs: [draft], complete: true });
  assert.deepEqual(await ledger.create(REQUEST, prepared), draft);
  assert.equal([...rows.values()].filter(row => row.kind === 'run').length, 1);
  const payload = [...rows.values()].find(row => row.kind === 'run').payload;
  assert.ok(!payload.includes('What is two plus two?') && !payload.includes('Four.'));
  assert.deepEqual(await new RunLedger(store, OTHER).history(), { runs: [], complete: true });
  await assert.rejects(() => new RunLedger(store, OTHER).get(draft.id), error => error.code === 'RUN_NOT_FOUND');
  await assert.rejects(() => new RunLedger(store, OTHER).approve(draft.id, draft.approvalDigest, prepared), error => error.code === 'RUN_NOT_FOUND');
  await assert.rejects(() => new RunLedger(store, OTHER).claimSubmission(draft.id, draft.approvalDigest), error => error.code === 'RUN_NOT_FOUND');
});

test('request IDs cannot be reused for a different frozen selection', async () => {
  const { store } = fixture();
  const prepared = await preparation(store);
  const ledger = new RunLedger(store, OWNER);
  await ledger.create(REQUEST, prepared);
  const changed = { ...prepared, target: { ...prepared.target, name: 'Renamed agent' } };
  await assert.rejects(() => ledger.create(REQUEST, changed), error => error.code === 'RUN_REQUEST_CONFLICT');
});

test('approval binds the exact snapshot and remains distinct from execution', async () => {
  const { rows, store, writes } = fixture();
  const prepared = await preparation(store);
  const ledger = new RunLedger(store, OWNER);
  const draft = await ledger.create(REQUEST, prepared);
  await assert.rejects(() => ledger.approve(draft.id, '0'.repeat(64), prepared), error => error.code === 'RUN_STALE');
  const changed = { ...prepared, target: { ...prepared.target, stage: 'sandbox' } };
  await assert.rejects(() => ledger.approve(draft.id, draft.approvalDigest, changed), error => error.code === 'RUN_STALE');
  assert.ok(!writes.includes('run_approval'));
  const approved = await ledger.approve(draft.id, draft.approvalDigest, prepared);
  assert.equal(approved.status, 'approved');
  assert.ok(approved.approvedAt);
  assert.deepEqual(await ledger.approve(draft.id, draft.approvalDigest, prepared), approved);
  assert.equal([...rows.values()].filter(row => row.kind === 'run_approval').length, 1);
  assert.equal([...rows.values()].filter(row => row.kind === 'run_claim').length, 0);
});

test('a submission claim is single-use, stays uncertain, and cannot be automatically retried', async () => {
  const { store } = fixture();
  const prepared = await preparation(store);
  const ledger = new RunLedger(store, OWNER);
  const draft = await ledger.create(REQUEST, prepared);
  await assert.rejects(() => ledger.claimSubmission(draft.id, draft.approvalDigest), error => error.code === 'APPROVAL_REQUIRED');
  await ledger.approve(draft.id, draft.approvalDigest, prepared);
  const attempts = await Promise.allSettled([
    ledger.claimSubmission(draft.id, draft.approvalDigest),
    ledger.claimSubmission(draft.id, draft.approvalDigest),
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await ledger.get(draft.id)).status, 'submission_uncertain');
  await assert.rejects(() => ledger.claimSubmission(draft.id, draft.approvalDigest), error => error.code === 'RUN_ALREADY_CLAIMED');
});

test('a job receipt requires a claim, persists exactly once, and remains unverified', async () => {
  const { rows, store } = fixture();
  const prepared = await preparation(store);
  const ledger = new RunLedger(store, OWNER);
  const draft = await ledger.create(REQUEST, prepared);
  await ledger.approve(draft.id, draft.approvalDigest, prepared);
  await assert.rejects(() => ledger.recordJobReceipt(draft.id, draft.approvalDigest, receipt), error => error.code === 'CLAIM_REQUIRED');
  await ledger.claimSubmission(draft.id, draft.approvalDigest);
  const accepted = await ledger.recordJobReceipt(draft.id, draft.approvalDigest, receipt);
  assert.equal(accepted.status, 'job_accepted');
  assert.deepEqual(accepted.job, receipt);
  assert.deepEqual(await ledger.recordJobReceipt(draft.id, draft.approvalDigest, receipt), accepted);
  assert.deepEqual(await ledger.get(draft.id), accepted);
  assert.equal([...rows.values()].filter(row => row.kind === 'run_receipt').length, 1);
  await assert.rejects(() => ledger.recordJobReceipt(draft.id, draft.approvalDigest, { ...receipt, jobId: OTHER }),
    error => error.code === 'JOB_RECEIPT_CONFLICT');
  await assert.rejects(() => ledger.claimSubmission(draft.id, draft.approvalDigest), error => error.code === 'RUN_ALREADY_CLAIMED');
});

test('invalid or ambiguous job receipt writes remain claimed and cannot be retried as submissions', async () => {
  const { store, writes } = fixture();
  const prepared = await preparation(store);
  const ledger = new RunLedger(store, OWNER);
  const draft = await ledger.create(REQUEST, prepared);
  await ledger.approve(draft.id, draft.approvalDigest, prepared);
  await ledger.claimSubmission(draft.id, draft.approvalDigest);
  for (const invalid of [{ ...receipt, jobId: 'bad' }, { ...receipt, firstPollAfterSeconds: -1 },
    { ...receipt, acceptedAt: 'bad' }, { ...receipt, extra: true }, null]) {
    await assert.rejects(() => ledger.recordJobReceipt(draft.id, draft.approvalDigest, invalid),
      error => error.code === 'JOB_RECEIPT_INVALID');
  }
  assert.equal(writes.filter(kind => kind === 'run_receipt').length, 0);
  const original = store.create;
  store.create = async row => { await original(row); if (row.kind === 'run_receipt') throw new Error('private storage failure'); };
  await assert.rejects(() => ledger.recordJobReceipt(draft.id, draft.approvalDigest, receipt),
    error => error.code === 'JOB_RECEIPT_UNCERTAIN' && !error.message.includes('private'));
  assert.equal((await ledger.get(draft.id)).status, 'job_accepted');
  assert.equal(writes.filter(kind => kind === 'run_receipt').length, 1);
  await assert.rejects(() => ledger.claimSubmission(draft.id, draft.approvalDigest), error => error.code === 'RUN_ALREADY_CLAIMED');
});

test('receipt without a valid claim is rejected rather than shown as an accepted job', async () => {
  const { rows, store } = fixture();
  const prepared = await preparation(store);
  const ledger = new RunLedger(store, OWNER);
  const draft = await ledger.create(REQUEST, prepared);
  await ledger.approve(draft.id, draft.approvalDigest, prepared);
  await ledger.claimSubmission(draft.id, draft.approvalDigest);
  await ledger.recordJobReceipt(draft.id, draft.approvalDigest, receipt);
  const claim = [...rows.values()].find(row => row.kind === 'run_claim');
  rows.delete(claim.id);
  await assert.rejects(() => ledger.get(draft.id), error => error.code === 'RUN_RECORD_INVALID');
});

test('lost acknowledgements never trigger retries and are recoverable through history', async () => {
  for (const kind of ['run', 'run_approval', 'run_claim']) {
    const { store, writes } = fixture();
    const prepared = await preparation(store);
    const baseCreate = store.create;
    let injected = false;
    store.create = async row => {
      await baseCreate(row);
      if (row.kind === kind && !injected) { injected = true; throw new Error('private provider error'); }
    };
    const ledger = new RunLedger(store, OWNER);
    if (kind === 'run') {
      await assert.rejects(() => ledger.create(REQUEST, prepared), error => error.code === 'RUN_SAVE_UNCERTAIN' && !error.message.includes('private'));
      assert.equal((await ledger.history()).runs.length, 1);
      assert.equal(writes.filter(value => value === kind).length, 1);
      continue;
    }
    const draft = await ledger.create(REQUEST, prepared);
    if (kind === 'run_approval') {
      await assert.rejects(() => ledger.approve(draft.id, draft.approvalDigest, prepared), error => error.code === 'APPROVAL_UNCERTAIN');
      assert.equal((await ledger.get(draft.id)).status, 'approved');
    } else {
      await ledger.approve(draft.id, draft.approvalDigest, prepared);
      await assert.rejects(() => ledger.claimSubmission(draft.id, draft.approvalDigest), error => error.code === 'SUBMISSION_UNCERTAIN');
      assert.equal((await ledger.get(draft.id)).status, 'submission_uncertain');
      await assert.rejects(() => ledger.claimSubmission(draft.id, draft.approvalDigest), error => error.code === 'RUN_ALREADY_CLAIMED');
    }
    assert.equal(writes.filter(value => value === kind).length, 1);
  }
});

test('a stale event readback cannot produce a success-shaped approval or claim', async () => {
  for (const kind of ['run_approval', 'run_claim']) {
    const { store } = fixture();
    const prepared = await preparation(store);
    const ledger = new RunLedger(store, OWNER);
    const draft = await ledger.create(REQUEST, prepared);
    if (kind === 'run_claim') await ledger.approve(draft.id, draft.approvalDigest, prepared);
    const original = store.record;
    let seen = 0;
    store.record = async (...args) => {
      const row = await original(...args);
      if (row?.kind === kind && ++seen === 2) return undefined;
      return row;
    };
    const action = kind === 'run_approval'
      ? () => ledger.approve(draft.id, draft.approvalDigest, prepared)
      : () => ledger.claimSubmission(draft.id, draft.approvalDigest);
    await assert.rejects(action, error => error.code === (kind === 'run_approval' ? 'APPROVAL_UNCERTAIN' : 'SUBMISSION_UNCERTAIN'));
  }
});

test('corrupt run headers and forged event markers are never silently omitted', async () => {
  for (const corrupt of [
    rows => { const row = [...rows.values()].find(value => value.kind === 'run'); row.payload = '{}'; },
    rows => { const row = [...rows.values()].find(value => value.kind === 'run');
      row.payload = row.payload.replace('"schemaVersion":1', '"schemaVersion":1,"\\u0073chemaVersion":1'); },
    rows => { const row = [...rows.values()].find(value => value.kind === 'run_approval'); row.payload = '{}'; },
    rows => { const row = [...rows.values()].find(value => value.kind === 'run_approval'); row.owner_id = OTHER; },
  ]) {
    const { rows, store } = fixture();
    const prepared = await preparation(store);
    const ledger = new RunLedger(store, OWNER);
    const draft = await ledger.create(REQUEST, prepared);
    await ledger.approve(draft.id, draft.approvalDigest, prepared);
    corrupt(rows);
    if ([...rows.values()].some(row => row.kind === 'run_approval' && row.owner_id === OTHER)) {
      assert.equal((await ledger.get(draft.id)).status, 'awaiting_approval');
    } else {
      await assert.rejects(() => ledger.history(), error => error.code === 'RUN_RECORD_INVALID');
    }
  }
});

test('run history reports truncation instead of claiming completeness', async () => {
  const { store } = fixture();
  const prepared = await preparation(store);
  const ledger = new RunLedger(store, OWNER);
  for (let index = 1; index <= 11; index++) {
    await ledger.create(`b0b000${String(index).padStart(2, '0')}-1234-4abc-8def-000000000001`, prepared);
  }
  const history = await ledger.history();
  assert.equal(history.runs.length, 10);
  assert.equal(history.complete, false);
});
