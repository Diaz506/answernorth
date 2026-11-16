import type { ProofbenchRecord, RunJobReceipt, RunPreparation, RunRecord } from '@rayfin-app/shared';
import { digest, object, SafeError, stableId, text, uuid } from './safety.js';
import type { Store } from './suites.js';
import { parseUniqueJson } from './json-integrity.js';

type Header = Omit<RunRecord, 'status' | 'approvedAt' | 'job'> & { schemaVersion: 1 };
const HASH = /^[0-9a-f]{64}$/;
const MAX_HISTORY = 10;

export function validApprovalDigest(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new SafeError('RUN_STALE', 'The reviewed run draft digest is invalid.');
  }
  return value;
}

function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).length !== expected.length || Object.keys(value).some(key => !expected.includes(key))) throw new Error();
}

function canonicalId(value: unknown): string {
  const parsed = uuid(value);
  if (parsed !== value) throw new Error();
  return parsed;
}

function canonicalText(value: unknown, min: number, max: number): string {
  const parsed = text(value, min, max);
  if (parsed !== value) throw new Error();
  return parsed;
}

function iso(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') throw new Error();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error();
  return date.toISOString();
}

function runId(owner: string, requestId: string): string {
  return stableId(['answernorth-run-v1', owner, requestId]);
}

function eventId(kind: 'approval' | 'claim' | 'receipt', owner: string, id: string): string {
  return stableId([`answernorth-run-${kind}-v1`, owner, id]);
}

export function submissionClaimId(owner: string, id: string): string {
  return eventId('claim', owner, uuid(id));
}

function approvalDigest(owner: string, header: Omit<Header, 'approvalDigest'>): string {
  const { target, suite } = header;
  return digest(['answernorth-approval-v1', owner, header.id, header.requestId, header.createdAt,
    target.workspaceId, target.id, target.workspaceName, target.name, target.stage,
    suite.id, suite.name, suite.version, suite.hash, suite.caseCount]);
}

function summary(preparation: RunPreparation): Pick<Header, 'target' | 'suite'> {
  return {
    target: { ...preparation.target },
    suite: { id: preparation.suite.id, name: preparation.suite.name, version: preparation.suite.version,
      hash: preparation.suite.hash, caseCount: preparation.suite.cases.length },
  };
}

function sameSnapshot(left: Pick<Header, 'target' | 'suite'>, right: Pick<Header, 'target' | 'suite'>): boolean {
  const a = left.target, b = right.target, x = left.suite, y = right.suite;
  return a.id === b.id && a.name === b.name && a.workspaceId === b.workspaceId && a.workspaceName === b.workspaceName &&
    a.stage === b.stage && a.publicationVerified === b.publicationVerified &&
    x.id === y.id && x.name === y.name && x.version === y.version && x.hash === y.hash && x.caseCount === y.caseCount;
}

function parseHeader(row: ProofbenchRecord, owner: string): Header {
  try {
    if (row.owner_id !== owner || row.kind !== 'run' || typeof row.payload !== 'string' || row.payload.length > 4000) throw new Error();
    const data = object(parseUniqueJson(row.payload));
    keys(data, ['schemaVersion', 'id', 'requestId', 'target', 'suite', 'createdAt', 'approvalDigest']);
    const target = object(data.target), suite = object(data.suite);
    keys(target, ['id', 'name', 'workspaceId', 'workspaceName', 'stage', 'publicationVerified']);
    keys(suite, ['id', 'name', 'version', 'hash', 'caseCount']);
    if (data.schemaVersion !== 1 || (target.stage !== 'production' && target.stage !== 'sandbox') ||
        target.publicationVerified !== false || !Number.isSafeInteger(suite.version) || Number(suite.version) < 1 ||
        !Number.isSafeInteger(suite.caseCount) || Number(suite.caseCount) < 1 || Number(suite.caseCount) > 30 ||
        typeof suite.hash !== 'string' || !HASH.test(suite.hash) ||
        typeof data.approvalDigest !== 'string' || !HASH.test(data.approvalDigest) ||
        typeof data.createdAt !== 'string' || iso(data.createdAt) !== data.createdAt) throw new Error();
    const result: Header = {
      schemaVersion: 1, id: canonicalId(data.id), requestId: canonicalId(data.requestId),
      target: { id: canonicalId(target.id), name: canonicalText(target.name, 1, 256),
        workspaceId: canonicalId(target.workspaceId), workspaceName: canonicalText(target.workspaceName, 1, 256),
        stage: target.stage, publicationVerified: false },
      suite: { id: canonicalId(suite.id), name: canonicalText(suite.name, 1, 120), version: Number(suite.version),
        hash: suite.hash, caseCount: Number(suite.caseCount) },
      createdAt: data.createdAt, approvalDigest: data.approvalDigest,
    };
    const { approvalDigest: hash, ...withoutHash } = result;
    if (row.id !== result.id || result.id !== runId(owner, result.requestId) || row.suiteId !== result.suite.id ||
        iso(row.createdAt) !== result.createdAt || approvalDigest(owner, withoutHash) !== hash) throw new Error();
    return result;
  } catch {
    throw new SafeError('RUN_RECORD_INVALID', 'A saved run draft failed integrity validation.');
  }
}

function parseEvent(row: ProofbenchRecord, owner: string, header: Header, kind: 'approval' | 'claim'): string {
  try {
    if (row.owner_id !== owner || row.kind !== `run_${kind}` || row.id !== eventId(kind, owner, header.id) ||
        row.suiteId !== header.id || typeof row.payload !== 'string' || row.payload.length > 4000) throw new Error();
    const event = object(parseUniqueJson(row.payload));
    keys(event, ['schemaVersion', 'runId', 'approvalDigest', 'createdAt']);
    if (event.schemaVersion !== 1 || event.runId !== header.id || event.approvalDigest !== header.approvalDigest ||
        typeof event.createdAt !== 'string' || iso(event.createdAt) !== event.createdAt ||
        iso(row.createdAt) !== event.createdAt) throw new Error();
    return event.createdAt;
  } catch {
    throw new SafeError('RUN_RECORD_INVALID', 'A saved run event failed integrity validation.');
  }
}

function parseJobReceipt(row: ProofbenchRecord, owner: string, header: Header): RunJobReceipt {
  try {
    if (row.owner_id !== owner || row.kind !== 'run_receipt' || row.id !== eventId('receipt', owner, header.id) ||
        row.suiteId !== header.id || typeof row.payload !== 'string' || row.payload.length > 4000) throw new Error();
    const data = object(parseUniqueJson(row.payload));
    keys(data, ['schemaVersion', 'runId', 'approvalDigest', 'workspaceId', 'notebookId', 'jobId', 'acceptedAt', 'firstPollAfterSeconds']);
    if (data.schemaVersion !== 1 || data.runId !== header.id || data.approvalDigest !== header.approvalDigest ||
        typeof data.acceptedAt !== 'string' || iso(data.acceptedAt) !== data.acceptedAt ||
        iso(row.createdAt) !== data.acceptedAt || !Number.isSafeInteger(data.firstPollAfterSeconds) ||
        Number(data.firstPollAfterSeconds) < 0 || Number(data.firstPollAfterSeconds) > 86400) throw new Error();
    return { workspaceId: canonicalId(data.workspaceId), notebookId: canonicalId(data.notebookId),
      jobId: canonicalId(data.jobId), acceptedAt: data.acceptedAt, firstPollAfterSeconds: Number(data.firstPollAfterSeconds) };
  } catch {
    throw new SafeError('RUN_RECORD_INVALID', 'A saved notebook job receipt failed integrity validation.');
  }
}

function sameJob(left: RunJobReceipt, right: RunJobReceipt): boolean {
  return left.workspaceId === right.workspaceId && left.notebookId === right.notebookId && left.jobId === right.jobId &&
    left.acceptedAt === right.acceptedAt && left.firstPollAfterSeconds === right.firstPollAfterSeconds;
}

export class RunLedger {
  constructor(private readonly store: Store, private readonly owner: string) {}

  private async header(id: string): Promise<Header> {
    const row = await this.store.record(this.owner, uuid(id));
    if (!row) throw new SafeError('RUN_NOT_FOUND', 'The run draft was not found or is not accessible.');
    return parseHeader(row, this.owner);
  }

  private async state(header: Header): Promise<RunRecord> {
    const approval = await this.store.record(this.owner, eventId('approval', this.owner, header.id));
    const claim = await this.store.record(this.owner, eventId('claim', this.owner, header.id));
    const receipt = await this.store.record(this.owner, eventId('receipt', this.owner, header.id));
    const approvedAt = approval ? parseEvent(approval, this.owner, header, 'approval') : undefined;
    if (claim) {
      parseEvent(claim, this.owner, header, 'claim');
      if (!approvedAt) throw new SafeError('RUN_RECORD_INVALID', 'A submission claim has no valid approval.');
    }
    if (receipt && !claim) throw new SafeError('RUN_RECORD_INVALID', 'A notebook receipt has no valid submission claim.');
    const job = receipt ? parseJobReceipt(receipt, this.owner, header) : undefined;
    const { schemaVersion: _schemaVersion, ...record } = header;
    return { ...record, status: job ? 'job_accepted' : claim ? 'submission_uncertain' : approval ? 'approved' : 'awaiting_approval',
      ...(approvedAt ? { approvedAt } : {}), ...(job ? { job } : {}) };
  }

  async get(id: string): Promise<RunRecord> {
    return this.state(await this.header(id));
  }

  async history(): Promise<{ runs: RunRecord[]; complete: boolean }> {
    const page = await this.store.runs(this.owner);
    if (page.items.length > 25) throw new SafeError('RUN_RECORD_INVALID', 'Run history exceeded its bounded page.');
    const runs: RunRecord[] = [];
    for (const row of page.items.slice(0, MAX_HISTORY)) runs.push(await this.state(parseHeader(row, this.owner)));
    return { runs, complete: !page.hasNextPage && page.items.length <= MAX_HISTORY };
  }

  async create(requestId: string, preparation: RunPreparation): Promise<RunRecord> {
    const request = uuid(requestId);
    const id = runId(this.owner, request);
    const selected = summary(preparation);
    const existing = await this.store.record(this.owner, id);
    if (existing) {
      const saved = parseHeader(existing, this.owner);
      if (!sameSnapshot(saved, selected)) throw new SafeError('RUN_REQUEST_CONFLICT', 'This request identifier already refers to a different run draft.');
      return this.state(saved);
    }
    const header: Omit<Header, 'approvalDigest'> = {
      schemaVersion: 1, id, requestId: request, ...selected, createdAt: new Date().toISOString(),
    };
    const full: Header = { ...header, approvalDigest: approvalDigest(this.owner, header) };
    const payload = JSON.stringify(full);
    if (payload.length > 4000) throw new SafeError('INVALID_INPUT', 'The run draft exceeds storage limits.');
    try {
      await this.store.create({ id, owner_id: this.owner, kind: 'run', suiteId: full.suite.id, createdAt: new Date(full.createdAt), payload });
      const row = await this.store.record(this.owner, id);
      if (!row) throw new Error();
      const saved = parseHeader(row, this.owner);
      if (!sameSnapshot(saved, selected) || saved.approvalDigest !== full.approvalDigest) throw new Error();
      return await this.state(saved);
    } catch (error) {
      if (error instanceof SafeError && error.code === 'RUN_RECORD_INVALID') throw error;
      throw new SafeError('RUN_SAVE_UNCERTAIN', 'The run draft may have been saved. Reload run history before retrying; no automatic retry was performed.');
    }
  }

  private async append(header: Header, kind: 'approval' | 'claim'): Promise<void> {
    const createdAt = new Date().toISOString();
    const payload = JSON.stringify({ schemaVersion: 1, runId: header.id, approvalDigest: header.approvalDigest, createdAt });
    const id = eventId(kind, this.owner, header.id);
    try {
      await this.store.create({ id, owner_id: this.owner, kind: `run_${kind}`, suiteId: header.id, createdAt: new Date(createdAt), payload });
      const saved = await this.store.record(this.owner, id);
      if (!saved) throw new Error();
      parseEvent(saved, this.owner, header, kind);
    } catch (error) {
      if (error instanceof SafeError && error.code === 'RUN_RECORD_INVALID') throw error;
      throw new SafeError(kind === 'approval' ? 'APPROVAL_UNCERTAIN' : 'SUBMISSION_UNCERTAIN',
        kind === 'approval' ? 'Approval may have been recorded. Reload run history before retrying; no automatic retry was performed.'
          : 'Submission state is uncertain. Reconcile this draft before any retry; no automatic retry was performed.');
    }
  }

  async approve(id: string, hash: string, preparation: RunPreparation): Promise<RunRecord> {
    const header = await this.header(id);
    if (validApprovalDigest(hash) !== header.approvalDigest ||
        !sameSnapshot(header, summary(preparation))) {
      throw new SafeError('RUN_STALE', 'The reviewed run draft no longer matches the selected suite or agent.');
    }
    const current = await this.state(header);
    if (current.status === 'submission_uncertain' || current.status === 'job_accepted') throw new SafeError('RUN_ALREADY_CLAIMED', 'This draft already has a submission claim.');
    if (current.status === 'approved') return current;
    await this.append(header, 'approval');
    try {
      const saved = await this.state(header);
      if (saved.status !== 'approved') throw new Error();
      return saved;
    }
    catch (error) {
      if (error instanceof SafeError && error.code === 'RUN_RECORD_INVALID') throw error;
      throw new SafeError('APPROVAL_UNCERTAIN', 'Approval may have been recorded. Reload run history before retrying; no automatic retry was performed.');
    }
  }

  /** Revalidation only; this never creates an approval. */
  async checkApproved(id: string, hash: string, preparation: RunPreparation): Promise<RunRecord> {
    const header = await this.header(id);
    if (validApprovalDigest(hash) !== header.approvalDigest || !sameSnapshot(header, summary(preparation))) {
      throw new SafeError('RUN_STALE', 'The approved run draft no longer matches the selected suite or agent.');
    }
    const current = await this.state(header);
    if (current.status !== 'approved') {
      throw new SafeError(current.status === 'submission_uncertain' || current.status === 'job_accepted' ? 'RUN_ALREADY_CLAIMED' : 'APPROVAL_REQUIRED',
        'The draft must be approved and have no existing submission claim.');
    }
    return current;
  }

  /** Revalidate a claimed snapshot without interpreting an uncertain claim as a submitted job. */
  async checkClaimed(id: string, hash: string, preparation: RunPreparation): Promise<RunRecord> {
    const header = await this.header(id);
    if (validApprovalDigest(hash) !== header.approvalDigest || !sameSnapshot(header, summary(preparation))) {
      throw new SafeError('RUN_STALE', 'The claimed run draft no longer matches the selected suite or agent.');
    }
    const current = await this.state(header);
    if (current.status !== 'submission_uncertain') {
      throw new SafeError('CLAIM_REQUIRED', 'The run must have an approved submission claim and no recorded job receipt.');
    }
    return current;
  }

  /** Internal reservation only: no dispatcher or public UDF calls this method. */
  async claimSubmission(id: string, hash: string): Promise<RunRecord> {
    const header = await this.header(id);
    if (validApprovalDigest(hash) !== header.approvalDigest) {
      throw new SafeError('RUN_STALE', 'The submission claim does not match the approved run draft.');
    }
    const current = await this.state(header);
    if (current.status !== 'approved') {
      throw new SafeError(current.status === 'submission_uncertain' || current.status === 'job_accepted' ? 'RUN_ALREADY_CLAIMED' : 'APPROVAL_REQUIRED',
        'The draft must be approved and have no existing submission claim.');
    }
    await this.append(header, 'claim');
    try {
      const saved = await this.state(header);
      if (saved.status !== 'submission_uncertain') throw new Error();
      return saved;
    }
    catch (error) {
      if (error instanceof SafeError && error.code === 'RUN_RECORD_INVALID') throw error;
      throw new SafeError('SUBMISSION_UNCERTAIN', 'Submission state is uncertain. Reconcile this draft before any retry; no automatic retry was performed.');
    }
  }

  /** Internal receipt persistence only; no public UDF accepts a caller-provided receipt. */
  async recordJobReceipt(id: string, hash: string, receipt: RunJobReceipt): Promise<RunRecord> {
    const header = await this.header(id);
    if (validApprovalDigest(hash) !== header.approvalDigest) throw new SafeError('RUN_STALE', 'The receipt does not match the approved run draft.');
    try { keys(object(receipt), ['workspaceId', 'notebookId', 'jobId', 'acceptedAt', 'firstPollAfterSeconds']); }
    catch { throw new SafeError('JOB_RECEIPT_INVALID', 'The notebook job receipt is invalid.'); }
    const current = await this.state(header);
    if (current.status === 'job_accepted' && current.job) {
      if (!sameJob(current.job, receipt)) throw new SafeError('JOB_RECEIPT_CONFLICT', 'The run already has a different notebook job receipt.');
      return current;
    }
    if (current.status !== 'submission_uncertain') throw new SafeError('CLAIM_REQUIRED', 'The run must have a valid submission claim before recording a receipt.');
    const recordId = eventId('receipt', this.owner, header.id);
    const payload = JSON.stringify({ schemaVersion: 1, runId: header.id, approvalDigest: header.approvalDigest,
      workspaceId: receipt.workspaceId, notebookId: receipt.notebookId, jobId: receipt.jobId,
      acceptedAt: receipt.acceptedAt, firstPollAfterSeconds: receipt.firstPollAfterSeconds });
    const row: ProofbenchRecord = { id: recordId, owner_id: this.owner, kind: 'run_receipt', suiteId: header.id,
      createdAt: new Date(receipt.acceptedAt), payload };
    try { parseJobReceipt(row, this.owner, header); }
    catch { throw new SafeError('JOB_RECEIPT_INVALID', 'The notebook job receipt is invalid.'); }
    try {
      await this.store.create(row);
      const saved = await this.store.record(this.owner, recordId);
      if (!saved || !sameJob(parseJobReceipt(saved, this.owner, header), receipt)) throw new Error();
      const result = await this.state(header);
      if (result.status !== 'job_accepted' || !result.job || !sameJob(result.job, receipt)) throw new Error();
      return result;
    } catch (error) {
      if (error instanceof SafeError && error.code === 'RUN_RECORD_INVALID') throw error;
      throw new SafeError('JOB_RECEIPT_UNCERTAIN', 'The job may be running but its receipt could not be confirmed. Reconcile before any retry.');
    }
  }
}
