import { isRequestId, type RunRecord } from './proofbench.service';

export const pendingRunKey = 'answernorth.pending-run.v1';
export type PendingRun = {
  requestId: string;
  selection: { workspaceId: string; agentId: string; suiteId: string; stage: 'production' | 'sandbox' };
};
export type PendingState =
  | { kind: 'empty' }
  | { kind: 'pending'; pending: PendingRun }
  | { kind: 'reconciled'; runId: string }
  | { kind: 'unavailable' | 'invalid' | 'conflict' };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 256;
}
function decode(raw: string): PendingRun | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!object(value) || Object.keys(value).sort().join(',') !== 'requestId,selection' || !isRequestId(value.requestId) || !object(value.selection)) return null;
    const selection = value.selection;
    if (Object.keys(selection).sort().join(',') !== 'agentId,stage,suiteId,workspaceId' ||
      !identifier(selection.workspaceId) || !identifier(selection.agentId) || !identifier(selection.suiteId) ||
      (selection.stage !== 'production' && selection.stage !== 'sandbox')) return null;
    return { requestId: value.requestId, selection: { workspaceId: selection.workspaceId, agentId: selection.agentId,
      suiteId: selection.suiteId, stage: selection.stage } };
  } catch { return null; }
}
function sameSelection(a: PendingRun['selection'], b: PendingRun['selection']): boolean {
  return a.workspaceId === b.workspaceId && a.agentId === b.agentId && a.suiteId === b.suiteId && a.stage === b.stage;
}
export function runMatchesPending(run: RunRecord, pending: PendingRun): boolean {
  return run.requestId === pending.requestId && run.target.workspaceId.toLowerCase() === pending.selection.workspaceId.toLowerCase() &&
    run.target.id.toLowerCase() === pending.selection.agentId.toLowerCase() &&
    run.suite.id.toLowerCase() === pending.selection.suiteId.toLowerCase() && run.target.stage === pending.selection.stage;
}
export function loadPending(runs: RunRecord[]): PendingState {
  try {
    const raw = sessionStorage.getItem(pendingRunKey);
    if (raw === null) return { kind: 'empty' };
    const pending = decode(raw);
    if (!pending) return { kind: 'invalid' };
    const matches = runs.filter((run) => run.requestId === pending.requestId);
    if (matches.length === 0) return { kind: 'pending', pending };
    if (matches.length !== 1 || !runMatchesPending(matches[0], pending)) return { kind: 'conflict' };
    sessionStorage.removeItem(pendingRunKey);
    if (sessionStorage.getItem(pendingRunKey) !== null) return { kind: 'unavailable' };
    return { kind: 'reconciled', runId: matches[0].id };
  } catch { return { kind: 'unavailable' }; }
}
export function persistPending(pending: PendingRun): boolean {
  try {
    if (sessionStorage.getItem(pendingRunKey) !== null) return false;
    const raw = JSON.stringify(pending);
    if (!decode(raw)) return false;
    sessionStorage.setItem(pendingRunKey, raw);
    return sessionStorage.getItem(pendingRunKey) === raw;
  } catch { return false; }
}
export function verifyPending(pending: PendingRun): boolean {
  try {
    const raw = sessionStorage.getItem(pendingRunKey);
    const current = raw === null ? null : decode(raw);
    return Boolean(current && current.requestId === pending.requestId && sameSelection(current.selection, pending.selection));
  } catch { return false; }
}
export function clearPending(pending: PendingRun): boolean {
  try {
    if (!verifyPending(pending)) return false;
    sessionStorage.removeItem(pendingRunKey);
    return sessionStorage.getItem(pendingRunKey) === null;
  } catch { return false; }
}
