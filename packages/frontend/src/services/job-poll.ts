const prefix = 'answernorth.job-poll.v1:';
const inFlight = '9999-12-31T23:59:59.999Z';
const reconcile = '9999-12-30T23:59:59.999Z';

export type PollTiming = { kind: 'ready'; notBefore: number } | { kind: 'blocked' } | { kind: 'reconcile' };

export function pollDeadline(timestamp: string, seconds: number): number | null {
  const deadline = Date.parse(timestamp) + seconds * 1000;
  return Number.isSafeInteger(deadline) && Math.abs(deadline) <= 8_640_000_000_000_000 ? deadline : null;
}

export function loadPollTiming(runId: string, initialDeadline: number): PollTiming {
  try {
    const raw = sessionStorage.getItem(prefix + encodeURIComponent(runId));
    if (raw === null) return { kind: 'ready', notBefore: initialDeadline };
    if (raw === inFlight) return { kind: 'blocked' };
    if (raw === reconcile) return { kind: 'reconcile' };
    const stored = Date.parse(raw);
    if (!Number.isFinite(stored) || new Date(stored).toISOString() !== raw) return { kind: 'blocked' };
    return { kind: 'ready', notBefore: Math.max(initialDeadline, stored) };
  } catch {
    return { kind: 'blocked' };
  }
}

function store(runId: string, value: string): boolean {
  try {
    const key = prefix + encodeURIComponent(runId);
    sessionStorage.setItem(key, value);
    return sessionStorage.getItem(key) === value;
  } catch {
    return false;
  }
}

export function markPollInFlight(runId: string): boolean {
  return store(runId, inFlight);
}

export function markPollReconcile(runId: string): boolean {
  return store(runId, reconcile);
}

export function storePollDeadline(runId: string, deadline: number): boolean {
  try {
    const value = new Date(deadline).toISOString();
    return value !== inFlight && value !== reconcile && store(runId, value);
  } catch {
    return false;
  }
}
