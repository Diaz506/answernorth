import { object, SafeError, uuid } from './safety.js';

export interface NotebookJobReceipt {
  jobId: string;
  firstPollAfterSeconds: number;
}

export type NotebookJobState =
  | 'job_not_started'
  | 'job_running'
  | 'job_completed_unverified'
  | 'job_failed'
  | 'job_cancelled'
  | 'job_deduped';

/** Parse a receipt only; never follow its Location or submit a job here. */
export function parseNotebookReceipt(
  status: number, location: unknown, retryAfter: unknown, workspaceId: string, notebookId: string,
): NotebookJobReceipt {
  const workspace = uuid(workspaceId), notebook = uuid(notebookId);
  if (status !== 202 || typeof location !== 'string' || location.length > 2048 || location !== location.trim() ||
      typeof retryAfter !== 'string' || !/^(?:0|[1-9]\d{0,4})$/.test(retryAfter) ||
      Number(retryAfter) > 86400) {
    throw new SafeError('JOB_SUBMISSION_UNCERTAIN', 'The notebook job receipt could not be verified. Do not retry submission automatically.');
  }
  try {
    const url = new URL(location);
    const hostAllowed = url.hostname === 'api.fabric.microsoft.com' ||
      /^wabi-[a-z0-9-]+\.analysis\.windows\.net$/.test(url.hostname);
    if (url.protocol !== 'https:' || !hostAllowed || url.username || url.password || url.port || url.search || url.hash) throw new Error();
    const path = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/(?:items\/([^/]+)\/jobs\/instances|notebooks\/([^/]+)\/jobs\/execute\/instances)\/([^/]+)\/?$/i);
    if (!path || uuid(path[1]) !== workspace || uuid(path[2] ?? path[3]) !== notebook) throw new Error();
    return { jobId: uuid(path[4]), firstPollAfterSeconds: Number(retryAfter) };
  } catch {
    throw new SafeError('JOB_SUBMISSION_UNCERTAIN', 'The notebook job receipt could not be verified. Do not retry submission automatically.');
  }
}

/** Always reconstruct a status URL from configured IDs, never from a Location header. */
export function notebookJobStatusUrl(workspaceId: string, notebookId: string, jobId: string): string {
  return `https://api.fabric.microsoft.com/v1/workspaces/${uuid(workspaceId)}/items/${uuid(notebookId)}/jobs/instances/${uuid(jobId)}`;
}

/** A completed notebook is not evidence that an evaluation or its results succeeded. */
export function parseNotebookJobStatus(value: unknown, notebookId: string, jobId: string): NotebookJobState {
  try {
    const row = object(value);
    if (uuid(row.id) !== uuid(jobId) || uuid(row.itemId) !== uuid(notebookId) ||
        row.jobType !== 'RunNotebook' || (row.invokeType !== 'Manual' && row.invokeType !== 'OnDemand')) throw new Error();
    const states: Record<string, NotebookJobState> = {
      NotStarted: 'job_not_started', InProgress: 'job_running', Completed: 'job_completed_unverified',
      Failed: 'job_failed', Cancelled: 'job_cancelled', Deduped: 'job_deduped',
    };
    if (typeof row.status !== 'string' || !Object.hasOwn(states, row.status) ||
        (row.status === 'Completed' && row.failureReason != null)) throw new Error();
    return states[row.status];
  } catch {
    throw new SafeError('JOB_STATUS_INVALID', 'The notebook job status could not be verified.');
  }
}
