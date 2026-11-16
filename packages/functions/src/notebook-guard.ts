import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ProofbenchRecord } from '@rayfin-app/shared';
import { NotebookJobClient } from './notebook-job-client.js';
import { RunLedger, validApprovalDigest } from './runs.js';
import { object, SafeError, stableId, uuid } from './safety.js';
import type { GuardKind, Store } from './suites.js';
import { parseUniqueJson } from './json-integrity.js';

const MAX_PAGES = 10;
const MAX_RECORDS = 1000;
const HISTORY_BUDGET_MS = 30_000;
const MAC = /^[0-9a-f]{64}$/;

export interface NotebookGuardLease {
  id: string;
  scopeId: string;
  generation: number;
  runId: string;
  approvalDigest: string;
  createdAt: string;
  mac: string;
}

interface Release {
  scopeId: string;
  generation: number;
  guardId: string;
  runId: string;
  approvalDigest: string;
  jobId: string;
  jobState: 'job_completed_unverified' | 'job_failed' | 'job_cancelled' | 'job_deduped';
  checkedAt: string;
  createdAt: string;
  mac: string;
}

function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).length !== expected.length || Object.keys(value).some(key => !expected.includes(key))) throw new Error();
}

function canonicalId(value: unknown): string {
  const parsed = uuid(value);
  if (value !== parsed) throw new Error();
  return parsed;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string') throw new Error();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error();
  return value;
}

function rowTimestamp(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') throw new Error();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error();
  return date.toISOString();
}

function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= MAX_RECORDS) throw new Error();
  return Number(value);
}

function lockId(scopeId: string, version: number): string {
  return stableId(['answernorth-notebook-guard-v1', scopeId, version]);
}

function releaseId(scopeId: string, version: number): string {
  return stableId(['answernorth-notebook-release-v1', scopeId, version]);
}

function signature(key: Buffer, values: unknown[]): string {
  return createHmac('sha256', key).update(JSON.stringify(values)).digest('hex');
}

function validMac(value: unknown, expected: string): boolean {
  if (typeof value !== 'string' || !MAC.test(value)) return false;
  return timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'));
}

async function beforeDeadline<T>(action: () => Promise<T>, deadline: number, code: string, message: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new SafeError(code, message);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SafeError(code, message)), remaining);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function lockMac(key: Buffer, owner: string, lease: Omit<NotebookGuardLease, 'mac'>): string {
  return signature(key, ['answernorth-notebook-guard-v1', owner, lease.id, lease.scopeId,
    lease.generation, lease.runId, lease.approvalDigest, lease.createdAt]);
}

function releaseMac(key: Buffer, owner: string, release: Omit<Release, 'mac'>): string {
  return signature(key, ['answernorth-notebook-release-v1', owner, release.scopeId, release.generation,
    release.guardId, release.runId, release.approvalDigest, release.jobId, release.jobState,
    release.checkedAt, release.createdAt]);
}

export class NotebookGuard {
  private readonly scopeId: string;
  private readonly workspaceId: string;
  private readonly notebookId: string;
  private readonly key: Buffer;
  private readonly ledger: RunLedger;

  constructor(private readonly store: Store, private readonly owner: string,
    private readonly client: NotebookJobClient, key: Buffer) {
    const scope = client.guardScope();
    if (uuid(owner) !== owner || owner !== scope.ownerId || !Buffer.isBuffer(key) || key.length !== 32) {
      throw new SafeError('CONFIGURATION_ERROR', 'The notebook guard configuration is invalid.');
    }
    this.scopeId = stableId(['answernorth-notebook-scope-v1', scope.tenantId, scope.workspaceId, scope.notebookId]);
    this.workspaceId = scope.workspaceId;
    this.notebookId = scope.notebookId;
    this.key = Buffer.from(key);
    this.ledger = new RunLedger(store, owner);
  }

  private parseLease(row: ProofbenchRecord): NotebookGuardLease {
    try {
      if (row.owner_id !== this.owner || row.kind !== 'notebook_guard' || row.suiteId !== this.scopeId ||
          typeof row.payload !== 'string' || row.payload.length > 4000) throw new Error();
      const value = object(parseUniqueJson(row.payload));
      keys(value, ['schemaVersion', 'scopeId', 'generation', 'runId', 'approvalDigest', 'createdAt', 'mac']);
      if (value.schemaVersion !== 1 || value.scopeId !== this.scopeId ||
          typeof value.approvalDigest !== 'string' || !MAC.test(value.approvalDigest)) throw new Error();
      const version = generation(value.generation);
      const lease: NotebookGuardLease = {
        id: lockId(this.scopeId, version), scopeId: this.scopeId, generation: version,
        runId: canonicalId(value.runId), approvalDigest: value.approvalDigest,
        createdAt: timestamp(value.createdAt), mac: typeof value.mac === 'string' ? value.mac : '',
      };
      const { mac, ...unsigned } = lease;
      if (row.id !== lease.id || rowTimestamp(row.createdAt) !== lease.createdAt ||
          !validMac(mac, lockMac(this.key, this.owner, unsigned))) throw new Error();
      return lease;
    } catch {
      throw new SafeError('GUARD_HISTORY_INVALID', 'Notebook guard history failed integrity validation.');
    }
  }

  private parseRelease(row: ProofbenchRecord, lease: NotebookGuardLease): Release {
    try {
      if (row.owner_id !== this.owner || row.kind !== 'notebook_guard_release' || row.suiteId !== this.scopeId ||
          row.id !== releaseId(this.scopeId, lease.generation) ||
          typeof row.payload !== 'string' || row.payload.length > 4000) throw new Error();
      const value = object(parseUniqueJson(row.payload));
      keys(value, ['schemaVersion', 'scopeId', 'generation', 'guardId', 'runId', 'approvalDigest',
        'jobId', 'jobState', 'checkedAt', 'createdAt', 'mac']);
      const state = value.jobState;
      if (value.schemaVersion !== 1 || value.scopeId !== this.scopeId || value.generation !== lease.generation ||
          value.guardId !== lease.id || value.runId !== lease.runId || value.approvalDigest !== lease.approvalDigest ||
          (state !== 'job_completed_unverified' && state !== 'job_failed' && state !== 'job_cancelled' && state !== 'job_deduped')) throw new Error();
      const release: Release = {
        scopeId: this.scopeId, generation: lease.generation, guardId: lease.id, runId: lease.runId,
        approvalDigest: lease.approvalDigest, jobId: canonicalId(value.jobId),
        jobState: state, checkedAt: timestamp(value.checkedAt),
        createdAt: timestamp(value.createdAt), mac: typeof value.mac === 'string' ? value.mac : '',
      };
      const { mac, ...unsigned } = release;
      if (rowTimestamp(row.createdAt) !== release.createdAt || !validMac(mac, releaseMac(this.key, this.owner, unsigned))) throw new Error();
      return release;
    } catch {
      throw new SafeError('GUARD_HISTORY_INVALID', 'Notebook guard history failed integrity validation.');
    }
  }

  private async pages(kind: GuardKind, deadline: number): Promise<ProofbenchRecord[]> {
    const rows: ProofbenchRecord[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (Date.now() >= deadline) throw new SafeError('GUARD_HISTORY_INCOMPLETE', 'Notebook guard history could not be fully checked.');
      const result = await beforeDeadline(() => this.store.guardPage(this.owner, this.scopeId, kind, cursor), deadline,
        'GUARD_HISTORY_INCOMPLETE', 'Notebook guard history could not be fully checked.');
      if (!Array.isArray(result.items) || result.items.length > 100 || typeof result.hasNextPage !== 'boolean') {
        throw new SafeError('GUARD_HISTORY_INVALID', 'Notebook guard history could not be verified.');
      }
      rows.push(...result.items);
      if (rows.length > MAX_RECORDS) throw new SafeError('GUARD_HISTORY_INCOMPLETE', 'Notebook guard history exceeded its limit.');
      if (!result.hasNextPage) return rows;
      if (typeof result.endCursor !== 'string' || !result.endCursor || result.endCursor.length > 8192 || cursors.has(result.endCursor)) {
        throw new SafeError('GUARD_HISTORY_INVALID', 'Notebook guard pagination could not be verified.');
      }
      cursor = result.endCursor;
      cursors.add(cursor);
    }
    throw new SafeError('GUARD_HISTORY_INCOMPLETE', 'Notebook guard history could not be fully checked.');
  }

  async acquire(runId: string, approvalDigest: string): Promise<NotebookGuardLease> {
    const deadline = Date.now() + HISTORY_BUDGET_MS;
    const run = await beforeDeadline(() => this.ledger.get(runId), deadline,
      'GUARD_HISTORY_INCOMPLETE', 'Notebook guard history could not be fully checked.');
    if (validApprovalDigest(approvalDigest) !== run.approvalDigest) {
      throw new SafeError('RUN_STALE', 'The notebook guard does not match the approved run.');
    }
    if (run.status !== 'approved') {
      throw new SafeError(run.status === 'awaiting_approval' ? 'APPROVAL_REQUIRED' : 'RUN_ALREADY_CLAIMED',
        'The draft must be approved and have no submission claim.');
    }
    const locks = (await this.pages('notebook_guard', deadline)).map(row => this.parseLease(row));
    const releaseRows = await this.pages('notebook_guard_release', deadline);
    locks.sort((a, b) => a.generation - b.generation);
    if (locks.some((lease, index) => lease.generation !== index)) {
      throw new SafeError('GUARD_HISTORY_INVALID', 'Notebook guard history is incomplete or inconsistent.');
    }
    const releases = new Set<number>();
    for (const row of releaseRows) {
      let version: number;
      try { version = generation(object(parseUniqueJson(row.payload)).generation); }
      catch { throw new SafeError('GUARD_HISTORY_INVALID', 'Notebook guard history is inconsistent.'); }
      const lease = locks[version];
      if (!lease || releases.has(version)) throw new SafeError('GUARD_HISTORY_INVALID', 'Notebook guard history is inconsistent.');
      this.parseRelease(row, lease);
      releases.add(version);
    }
    if (locks.some((lease, index) => index < locks.length - 1 && !releases.has(lease.generation))) {
      throw new SafeError('GUARD_HISTORY_INVALID', 'Notebook guard history is incomplete or inconsistent.');
    }
    if (locks.length && !releases.has(locks.length - 1)) {
      throw new SafeError('GUARD_BUSY', 'Another run holds the notebook guard. Resolve it before submitting another run.');
    }
    if (locks.length >= MAX_RECORDS) throw new SafeError('GUARD_HISTORY_INCOMPLETE', 'Notebook guard history reached its supported limit.');
    const version = locks.length;
    const unsigned = { id: lockId(this.scopeId, version), scopeId: this.scopeId, generation: version,
      runId: run.id, approvalDigest: run.approvalDigest, createdAt: new Date().toISOString() };
    const lease = { ...unsigned, mac: lockMac(this.key, this.owner, unsigned) };
    const payload = JSON.stringify({ schemaVersion: 1, scopeId: lease.scopeId, generation: lease.generation,
      runId: lease.runId, approvalDigest: lease.approvalDigest, createdAt: lease.createdAt, mac: lease.mac });
    try {
      return await beforeDeadline(async () => {
        await this.store.create({ id: lease.id, owner_id: this.owner, kind: 'notebook_guard', suiteId: this.scopeId,
          createdAt: new Date(lease.createdAt), payload });
        const row = await this.store.record(this.owner, lease.id);
        if (!row || this.parseLease(row).mac !== lease.mac) throw new Error();
        return lease;
      }, deadline, 'GUARD_ACQUIRE_UNCERTAIN', 'The notebook guard could not be confirmed. Reconcile it before retrying.');
    } catch (error) {
      if (error instanceof SafeError && error.code === 'GUARD_HISTORY_INVALID') throw error;
      throw new SafeError('GUARD_ACQUIRE_UNCERTAIN', 'The notebook guard could not be confirmed. Reconcile it before retrying.');
    }
  }

  /** Release only after a recorded job is terminal and recent-job history is clear. */
  async releaseVerified(leaseId: string): Promise<void> {
    const deadline = Date.now() + HISTORY_BUDGET_MS;
    const blocked = 'The notebook guard release could not be verified and remains held.';
    const row = await beforeDeadline(() => this.store.record(this.owner, uuid(leaseId)), deadline, 'GUARD_RELEASE_BLOCKED', blocked);
    if (!row) throw new SafeError('GUARD_NOT_FOUND', 'The notebook guard was not found or is not accessible.');
    const lease = this.parseLease(row);
    const prior = await beforeDeadline(() => this.store.record(this.owner, releaseId(this.scopeId, lease.generation)),
      deadline, 'GUARD_RELEASE_BLOCKED', blocked);
    if (prior) { this.parseRelease(prior, lease); return; }
    const run = await beforeDeadline(() => this.ledger.get(lease.runId), deadline, 'GUARD_RELEASE_BLOCKED', blocked);
    if (run.status !== 'job_accepted' || !run.job || run.approvalDigest !== lease.approvalDigest ||
        run.job.workspaceId !== this.workspaceId || run.job.notebookId !== this.notebookId) {
      throw new SafeError('GUARD_RELEASE_BLOCKED', 'The notebook guard cannot be released without its matching job receipt.');
    }
    const job = run.job;
    const observation = await beforeDeadline(() => this.client.observe(job), deadline, 'GUARD_RELEASE_BLOCKED', blocked);
    if (observation.state === 'job_not_started' || observation.state === 'job_running') {
      throw new SafeError('GUARD_JOB_ACTIVE', 'The notebook job is not terminal; the guard remains held.');
    }
    await beforeDeadline(() => this.client.assertNoRecentJobs(job.jobId), deadline, 'GUARD_RELEASE_BLOCKED', blocked);
    const unsigned: Omit<Release, 'mac'> = { scopeId: this.scopeId, generation: lease.generation, guardId: lease.id,
      runId: lease.runId, approvalDigest: lease.approvalDigest, jobId: job.jobId, jobState: observation.state,
      checkedAt: observation.checkedAt, createdAt: new Date().toISOString() };
    const release: Release = { ...unsigned, mac: releaseMac(this.key, this.owner, unsigned) };
    const payload = JSON.stringify({ schemaVersion: 1, ...release });
    const id = releaseId(this.scopeId, lease.generation);
    try {
      await beforeDeadline(async () => {
        await this.store.create({ id, owner_id: this.owner, kind: 'notebook_guard_release', suiteId: this.scopeId,
          createdAt: new Date(release.createdAt), payload });
        const saved = await this.store.record(this.owner, id);
        if (!saved || this.parseRelease(saved, lease).mac !== release.mac) throw new Error();
      }, deadline, 'GUARD_RELEASE_UNCERTAIN', 'The notebook guard release could not be confirmed. Reconcile it before retrying.');
    } catch (error) {
      if (error instanceof SafeError && error.code === 'GUARD_HISTORY_INVALID') throw error;
      throw new SafeError('GUARD_RELEASE_UNCERTAIN', 'The notebook guard release could not be confirmed. Reconcile it before retrying.');
    }
  }
}
