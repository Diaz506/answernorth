import type { NotebookJobObservation, RunJobReceipt } from '@rayfin-app/shared';
import type { Request } from './metadata.js';
import { notebookJobStatusUrl, parseNotebookJobStatus, parseNotebookReceipt, type NotebookJobReceipt } from './notebook-job-protocol.js';
import { fabricToken, object, SafeError, uuid, type DeploymentConfig, type JobExecutionConfig } from './safety.js';
import { parseUniqueJson } from './json-integrity.js';

const BODY_LIMIT = 1_048_576;
const TIMEOUT_MS = 30_000;

function retryAfter(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(?:0|[1-9]\d{0,4})$/.test(value) || Number(value) > 86400) {
    throw new SafeError('JOB_STATUS_INVALID', 'The notebook job polling delay could not be verified.');
  }
  return Number(value);
}

function utcTime(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z?$/.test(value)) {
    throw new SafeError('JOB_PRECHECK_INVALID', 'Recent notebook job history could not be verified.');
  }
  const parsed = Date.parse(value.endsWith('Z') ? value : `${value}Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new SafeError('JOB_PRECHECK_INVALID', 'Recent notebook job history could not be verified.');
  }
  return parsed;
}

function precheckObject(value: unknown): Record<string, unknown> {
  try { return object(value); }
  catch { throw new SafeError('JOB_PRECHECK_INVALID', 'Recent notebook job history could not be verified.'); }
}

function precheckId(value: unknown): string {
  try { return uuid(value); }
  catch { throw new SafeError('JOB_PRECHECK_INVALID', 'Recent notebook job history could not be verified.'); }
}

async function readStatus(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) {
    throw new SafeError('JOB_STATUS_INVALID', 'The notebook job status exceeded its size limit.');
  }
  if (!response.body) throw new SafeError('JOB_STATUS_INVALID', 'The notebook job status was empty.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > BODY_LIMIT) {
        await reader.cancel();
        throw new SafeError('JOB_STATUS_INVALID', 'The notebook job status exceeded its size limit.');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new SafeError('JOB_STATUS_INVALID', 'The notebook job status could not be verified.'); }
}

async function bounded<T>(action: (signal: AbortSignal) => Promise<T>, code: string, message: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new SafeError(code, message)); }, TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError(code, message);
  } finally { if (timer) clearTimeout(timer); }
}

/** Internal transport; no public UDF calls submitOnce while execution is disabled. */
export class NotebookJobClient {
  private readonly token: string;
  private readonly tenantId: string;
  private readonly ownerId: string;
  private readonly workspaceId: string;
  private readonly notebookId: string;

  constructor(token: string, deployment: DeploymentConfig, execution: JobExecutionConfig,
    private readonly request: Request = fetch, private readonly now: () => number = Date.now) {
    this.token = fabricToken(token, deployment);
    this.tenantId = uuid(deployment.tenantId);
    this.ownerId = uuid(deployment.ownerId);
    this.workspaceId = uuid(execution.workspaceId);
    this.notebookId = uuid(execution.notebookId);
  }

  guardScope(): { tenantId: string; ownerId: string; workspaceId: string; notebookId: string } {
    return { tenantId: this.tenantId, ownerId: this.ownerId, workspaceId: this.workspaceId, notebookId: this.notebookId };
  }

  /** One bounded read sequence; never submit when recent job history is incomplete. */
  async assertNoRecentJobs(expectedTerminalJobId?: string): Promise<void> {
    const root = `https://api.fabric.microsoft.com/v1/workspaces/${this.workspaceId}/items/${this.notebookId}/jobs/instances`;
    const expected = expectedTerminalJobId === undefined ? undefined : uuid(expectedTerminalJobId);
    return bounded(async signal => {
      let continuation: string | undefined;
      let foundExpected = false;
      const tokens = new Set<string>(), seen = new Set<string>();
      for (let page = 0; page < 10; page++) {
        const url = new URL(root);
        if (continuation) url.searchParams.set('continuationToken', continuation);
        const response = await this.request(url.toString(), {
          method: 'GET', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', 'x-ms-fabric-skill': 'spark-cli' },
        });
        if (response.status !== 200) {
          if (response.body) await response.body.cancel();
          if (response.status === 429) {
            let delay: number | null;
            try { delay = retryAfter(response.headers.get('retry-after')); }
            catch (error) {
              if (error instanceof SafeError && error.code === 'JOB_STATUS_INVALID') {
                throw new SafeError('JOB_PRECHECK_THROTTLED', 'The notebook precheck was throttled without a valid retry delay. Resolve the issue before retrying.');
              }
              throw error;
            }
            throw new SafeError('JOB_PRECHECK_THROTTLED', delay === null
              ? 'The notebook precheck was throttled without a retry delay. Resolve the issue before retrying.'
              : 'The notebook precheck was throttled. No submission was attempted.', delay ?? undefined);
          }
          throw new SafeError('JOB_PRECHECK_UNAVAILABLE', 'Recent notebook jobs could not be checked. No submission was attempted.');
        }
        const data = await readStatus(response);
        const record = precheckObject(data);
        if (!Array.isArray(record.value) || record.value.length > 100) {
          throw new SafeError('JOB_PRECHECK_INVALID', 'Recent notebook job history could not be verified.');
        }
        for (const value of record.value) {
          const row = precheckObject(value);
          const id = precheckId(row.id);
          if (seen.has(id) || precheckId(row.itemId) !== this.notebookId || row.jobType !== 'RunNotebook' || typeof row.status !== 'string') {
            throw new SafeError('JOB_PRECHECK_INVALID', 'Recent notebook job history could not be verified.');
          }
          seen.add(id);
          if (row.status === 'NotStarted' || row.status === 'InProgress') {
            throw new SafeError('JOB_RECENT_OR_ACTIVE', 'A recent or active notebook job exists. Inspect it before submitting another.');
          }
          if (!['Completed', 'Failed', 'Cancelled', 'Deduped'].includes(row.status)) {
            throw new SafeError('JOB_PRECHECK_INVALID', 'Recent notebook job history could not be verified.');
          }
          if (id === expected) foundExpected = true;
          if (utcTime(row.startTimeUtc) >= this.now() - 300_000) {
            throw new SafeError('JOB_RECENT_OR_ACTIVE', 'A recent or active notebook job exists. Inspect it before submitting another.');
          }
        }
        if (record.continuationToken === undefined || record.continuationToken === null || record.continuationToken === '') {
          if (expected && !foundExpected) {
            throw new SafeError('JOB_PRECHECK_INCOMPLETE', 'The recorded terminal job was not found in notebook history.');
          }
          return;
        }
        if (typeof record.continuationToken !== 'string' || record.continuationToken.length > 8192 || tokens.has(record.continuationToken)) {
          throw new SafeError('JOB_PRECHECK_INVALID', 'Recent notebook job pagination could not be verified.');
        }
        continuation = record.continuationToken;
        tokens.add(continuation);
      }
      throw new SafeError('JOB_PRECHECK_INCOMPLETE', 'Recent notebook job history was incomplete. No submission was attempted.');
    }, 'JOB_PRECHECK_UNAVAILABLE', 'Recent notebook jobs could not be checked. No submission was attempted.');
  }

  /** Exactly one POST; an ambiguous response is never retried. */
  async submitOnce(runId: string, attemptId: string): Promise<RunJobReceipt> {
    const run = uuid(runId), attempt = uuid(attemptId);
    const url = `https://api.fabric.microsoft.com/v1/workspaces/${this.workspaceId}/items/${this.notebookId}/jobs/instances?jobType=RunNotebook`;
    const body = JSON.stringify({ parameters: [
      { name: 'run_id', value: run, type: 'Guid' },
      { name: 'attempt_id', value: attempt, type: 'Guid' },
    ] });
    return bounded(async signal => {
      const response = await this.request(url, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'x-ms-fabric-skill': 'spark-cli' },
        body,
      });
      let receipt: NotebookJobReceipt;
      try {
        receipt = parseNotebookReceipt(response.status, response.headers.get('location'),
          response.headers.get('retry-after'), this.workspaceId, this.notebookId);
      } finally { if (response.body) await response.body.cancel(); }
      return { workspaceId: this.workspaceId, notebookId: this.notebookId, jobId: receipt.jobId,
        acceptedAt: new Date(this.now()).toISOString(), firstPollAfterSeconds: receipt.firstPollAfterSeconds };
    }, 'JOB_SUBMISSION_UNCERTAIN', 'The notebook submission may have succeeded. Do not retry automatically.');
  }

  /** Exactly one status GET; completed is never treated as verified evaluation output. */
  async observe(receipt: RunJobReceipt): Promise<NotebookJobObservation> {
    if (uuid(receipt.workspaceId) !== this.workspaceId || uuid(receipt.notebookId) !== this.notebookId ||
        typeof receipt.acceptedAt !== 'string' || !Number.isSafeInteger(receipt.firstPollAfterSeconds) ||
        receipt.firstPollAfterSeconds < 0 || receipt.firstPollAfterSeconds > 86400) {
      throw new SafeError('JOB_RECEIPT_INVALID', 'The notebook job receipt does not match the configured target.');
    }
    const acceptedAt = Date.parse(receipt.acceptedAt);
    if (!Number.isFinite(acceptedAt) || new Date(acceptedAt).toISOString() !== receipt.acceptedAt) {
      throw new SafeError('JOB_RECEIPT_INVALID', 'The notebook job receipt timestamp is invalid.');
    }
    if (this.now() < acceptedAt + receipt.firstPollAfterSeconds * 1000) {
      throw new SafeError('JOB_POLL_TOO_EARLY', 'The notebook job is not ready to poll yet.');
    }
    const url = notebookJobStatusUrl(this.workspaceId, this.notebookId, receipt.jobId);
    return bounded(async signal => {
      const response = await this.request(url, {
        method: 'GET', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', 'x-ms-fabric-skill': 'spark-cli' },
      });
      if (response.status !== 200) {
        if (response.body) await response.body.cancel();
        let delay: number | null = null;
        if (response.status === 429) {
          try { delay = retryAfter(response.headers.get('retry-after')); }
          catch (error) {
            if (error instanceof SafeError && error.code === 'JOB_STATUS_INVALID') {
              throw new SafeError('JOB_THROTTLED', 'The notebook service was throttled without a valid retry delay. Resolve the issue before retrying.');
            }
            throw error;
          }
        }
        const code = response.status === 429 ? 'JOB_THROTTLED' : response.status === 403 ? 'JOB_FORBIDDEN'
          : response.status === 404 ? 'JOB_NOT_FOUND' : 'JOB_STATUS_UNAVAILABLE';
        const message = response.status === 429 && delay === null
          ? 'The notebook service was throttled without a retry delay. Resolve the issue before retrying.'
          : 'The notebook job status is unavailable. No retry was performed.';
        throw new SafeError(code, message, delay ?? undefined);
      }
      const delay = retryAfter(response.headers.get('retry-after'));
      const value = await readStatus(response);
      return { state: parseNotebookJobStatus(value, this.notebookId, receipt.jobId),
        checkedAt: new Date(this.now()).toISOString(), nextPollAfterSeconds: delay };
    }, 'JOB_STATUS_UNAVAILABLE', 'The notebook job status is unavailable. No retry was performed.');
  }
}
