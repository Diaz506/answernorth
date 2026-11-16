import { getRayfinClient } from '../lib/rayfin-client';
import { NetworkError } from '@microsoft/rayfin-lib';
import type { Agent, AgentsResponse, Bootstrap, NotebookJobObservation, RunRecord, Suite, TestCase, Workspace } from '@rayfin-app/shared';

export type { Agent, Bootstrap, RunRecord, Suite, Workspace } from '@rayfin-app/shared';
export type SuiteCase = TestCase;
export type AgentInventory = AgentsResponse;

export interface ProofbenchService {
  bootstrap(): Promise<Bootstrap>;
  listAgents(workspaceId: string): Promise<AgentInventory>;
  saveSuite(input: { name: string; cases: SuiteCase[] }): Promise<Suite>;
  createRun(selection: { workspaceId: string; agentId: string; suiteId: string; stage: 'production' | 'sandbox' }, requestId: string): Promise<RunRecord>;
  approveRun(runId: string, approvalDigest: string): Promise<RunRecord>;
  runStatus(runId: string): Promise<{ run: RunRecord; job: NotebookJobObservation | null }>;
}

export class InvalidProofbenchResponseError extends Error {
  constructor() {
    super('The cloud service returned an invalid AnswerNorth response.');
    this.name = 'InvalidProofbenchResponseError';
  }
}

export class BackendRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendRunError';
  }
}

export class JobThrottledError extends Error {
  readonly retryAfterSeconds: number | null;
  constructor(value: unknown) {
    super('Notebook job status is throttled.');
    this.name = 'JobThrottledError';
    this.retryAfterSeconds = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 86400 ? value : null;
  }
}

export class UncertainRunWriteError extends Error {
  constructor(readonly operation: 'create' | 'approve') {
    super(operation === 'create' ? 'The draft save may have completed.' : 'The approval may have completed.');
    this.name = 'UncertainRunWriteError';
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidProofbenchResponseError();
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, allowEmpty = false, maxLength = Number.POSITIVE_INFINITY): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxLength) {
    throw new InvalidProofbenchResponseError();
  }
  return value;
}

function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new InvalidProofbenchResponseError();
  return value;
}

function timestamp(value: unknown): string {
  const result = text(value);
  if (Number.isNaN(Date.parse(result))) throw new InvalidProofbenchResponseError();
  return result;
}

export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new InvalidProofbenchResponseError();
  return value.map(parse);
}

function workspace(value: unknown): Workspace {
  const item = record(value);
  return { id: text(item.id), name: text(item.name) };
}

function agent(value: unknown): Agent {
  const item = record(value);
  return { ...workspace(item), workspaceId: text(item.workspaceId), workspaceName: text(item.workspaceName) };
}

function suiteCase(value: unknown): SuiteCase {
  const item = record(value);
  return {
    id: text(item.id), question: text(item.question, false, 1000), expectedAnswer: text(item.expectedAnswer, false, 1500),
    category: text(item.category, true, 80), critical: flag(item.critical),
  };
}

function suite(value: unknown): Suite {
  const item = record(value);
  if (!Number.isSafeInteger(item.version) || Number(item.version) < 1) {
    throw new InvalidProofbenchResponseError();
  }
  const cases = list(item.cases, suiteCase);
  if (!cases.length || cases.length > 30 || new Set(cases.map((entry) => entry.id)).size !== cases.length) {
    throw new InvalidProofbenchResponseError();
  }
  return {
    id: text(item.id), name: text(item.name), version: Number(item.version),
    createdAt: timestamp(item.createdAt), hash: text(item.hash), cases,
  };
}

function run(value: unknown): RunRecord {
  const item = record(value);
  const target = record(item.target);
  const frozenSuite = record(item.suite);
  if ((target.stage !== 'production' && target.stage !== 'sandbox') || target.publicationVerified !== false ||
      (item.status !== 'awaiting_approval' && item.status !== 'approved' && item.status !== 'submission_uncertain' && item.status !== 'job_accepted') ||
      !Number.isSafeInteger(frozenSuite.version) || Number(frozenSuite.version) < 1 ||
      !Number.isSafeInteger(frozenSuite.caseCount) || Number(frozenSuite.caseCount) < 1 || Number(frozenSuite.caseCount) > 30) {
    throw new InvalidProofbenchResponseError();
  }
  const approvedAt = item.approvedAt === undefined ? undefined : timestamp(item.approvedAt);
  if (!isRequestId(item.requestId)) throw new InvalidProofbenchResponseError();
  const job = item.job === undefined ? undefined : receipt(item.job);
  if (item.status === 'job_accepted' && !job) throw new InvalidProofbenchResponseError();
  return {
    id: text(item.id), requestId: item.requestId, target: { ...agent(target), stage: target.stage, publicationVerified: false },
    suite: { id: text(frozenSuite.id), name: text(frozenSuite.name), version: Number(frozenSuite.version),
      hash: text(frozenSuite.hash), caseCount: Number(frozenSuite.caseCount) },
    createdAt: timestamp(item.createdAt), approvalDigest: text(item.approvalDigest), status: item.status,
    ...(approvedAt === undefined ? {} : { approvedAt }),
    ...(job === undefined ? {} : { job }),
  };
}

function seconds(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new InvalidProofbenchResponseError();
  return Number(value);
}

function receipt(value: unknown): NonNullable<RunRecord['job']> {
  const item = record(value);
  return {
    workspaceId: text(item.workspaceId), notebookId: text(item.notebookId), jobId: text(item.jobId),
    acceptedAt: timestamp(item.acceptedAt), firstPollAfterSeconds: seconds(item.firstPollAfterSeconds),
  };
}

function observation(value: unknown): NotebookJobObservation {
  const item = record(value);
  if (item.state !== 'job_not_started' && item.state !== 'job_running' && item.state !== 'job_completed_unverified' &&
      item.state !== 'job_failed' && item.state !== 'job_cancelled' && item.state !== 'job_deduped') {
    throw new InvalidProofbenchResponseError();
  }
  return { state: item.state, checkedAt: timestamp(item.checkedAt),
    nextPollAfterSeconds: item.nextPollAfterSeconds === null ? null : seconds(item.nextPollAfterSeconds) };
}

function json(value: unknown): unknown {
  let parsed = value;
  if (typeof value === 'string') {
    if (value.length > 1_000_000) throw new InvalidProofbenchResponseError();
    try { parsed = JSON.parse(value) as unknown; }
    catch { throw new InvalidProofbenchResponseError(); }
  }
  const result = record(parsed);
  if (typeof result.error === 'object' && result.error !== null && !Array.isArray(result.error)) {
    const errorInfo = result.error as Record<string, unknown>;
    const code = errorInfo.code;
    if (code === 'JOB_THROTTLED') throw new JobThrottledError(errorInfo.retryAfterSeconds);
    if (code === 'CONFIGURATION_ERROR') {
      const error = new Error('Backend configuration is invalid.'); error.name = 'BackendConfigurationError'; throw error;
    }
    if (code === 'PILOT_ACCESS_DENIED' || code === 'TENANT_SCOPE' || code === 'IDENTITY_SCOPE' || code === 'AUTH_REQUIRED' || code === 'STORAGE_SCOPE') {
      const error = new Error('Access denied.'); error.name = 'BackendAccessError'; throw error;
    }
    const runErrors: Record<string, string> = {
      RUN_STALE: 'The draft no longer matches the original agent or suite.',
      RUN_ALREADY_CLAIMED: 'This draft has an unresolved submission claim.',
      RUN_NOT_FOUND: 'The draft was not found or is not accessible.',
      RUN_RECORD_INVALID: 'A saved draft failed integrity validation.',
      RUN_REQUEST_CONFLICT: 'The draft request conflicts with an existing record.',
      INVALID_INPUT: 'The requested draft contains invalid input.',
      INVALID_SCOPE: 'The agent or suite does not match the selection.',
      AMBIGUOUS_SUITE: 'The suite contains duplicate questions and must be revised.',
      INVALID_AGENT: 'The selected agent is invalid or unavailable.',
      FEATURE_DISABLED: 'This feature is not available.',
    };
    if (code === 'RUN_SAVE_UNCERTAIN' || code === 'APPROVAL_UNCERTAIN') {
      throw new UncertainRunWriteError(code === 'RUN_SAVE_UNCERTAIN' ? 'create' : 'approve');
    }
    if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(runErrors, code)) {
      throw new BackendRunError(runErrors[code]);
    }
    throw new InvalidProofbenchResponseError();
  }
  return result;
}

export function parseBootstrap(value: unknown): Bootstrap {
  const item = record(json(value));
  const capabilities = record(item.capabilities);
  if (capabilities.cloudOnly !== true || capabilities.evaluationExecution !== false) {
    throw new InvalidProofbenchResponseError();
  }
  return {
    workspace: workspace(item.workspace), workspaces: list(item.workspaces, workspace),
    suiteVersions: list(item.suiteVersions, suite), runs: list(item.runs, run),
    capabilities: { cloudOnly: true, evaluationExecution: false },
    checkedAt: timestamp(item.checkedAt), workspacesComplete: flag(item.workspacesComplete),
    suitesComplete: flag(item.suitesComplete), runsComplete: flag(item.runsComplete), executionBlocker: text(item.executionBlocker),
  };
}

export function parseAgents(value: unknown): AgentInventory {
  const item = record(json(value));
  return { agents: list(item.agents, agent), complete: flag(item.complete), checkedAt: timestamp(item.checkedAt) };
}

export function parseSavedSuite(value: unknown): Suite {
  return suite(record(json(value)).suite);
}

export function parseRun(value: unknown): RunRecord {
  return run(record(json(value)).run);
}

export function parseJobStatus(value: unknown, runId: string): { run: RunRecord; job: NotebookJobObservation | null } {
  const envelope = record(json(value));
  const parsedRun = run(envelope.run);
  if (parsedRun.id !== runId || parsedRun.status !== 'job_accepted' || !parsedRun.job) {
    throw new InvalidProofbenchResponseError();
  }
  return { run: parsedRun, job: envelope.job === null ? null : observation(envelope.job) };
}

export const proofbenchService: ProofbenchService = {
  async bootstrap() {
    const client = await getRayfinClient();
    return parseBootstrap(await client.functions.proofbenchBootstrap.invoke(undefined, { timeoutMs: 25000 }));
  },
  async listAgents(workspaceId) {
    const client = await getRayfinClient();
    const result = parseAgents(await client.functions.proofbenchAgents.invoke({ workspaceId }, { timeoutMs: 25000 }));
    if (result.agents.some((item) => item.workspaceId.toLowerCase() !== workspaceId.toLowerCase())) {
      throw new InvalidProofbenchResponseError();
    }
    return result;
  },
  async saveSuite(input) {
    const client = await getRayfinClient();
    const payload = {
      name: input.name,
      cases: input.cases.map((item) => ({
        question: item.question, expectedAnswer: item.expectedAnswer,
        category: item.category, critical: item.critical,
      })),
    };

    return parseSavedSuite(await client.functions.proofbenchSaveSuite.invoke({ suiteJson: JSON.stringify(payload) }, { timeoutMs: 25000 }));
  },
  async createRun(selection, requestId) {
    const client = await getRayfinClient();
    return parseRun(await client.functions.proofbenchCreateRun.invoke({ selectionJson: JSON.stringify(selection), requestId }, { timeoutMs: 25000 }));
  },
  async approveRun(runId, approvalDigest) {
    const client = await getRayfinClient();
    return parseRun(await client.functions.proofbenchApproveRun.invoke({ runId, approvalDigest }, { timeoutMs: 25000 }));
  },
  async runStatus(runId) {
    let response: unknown;
    try {
      const client = await getRayfinClient();
      response = await client.functions.proofbenchRunStatus.invoke({ runId }, { timeoutMs: 25000 });
    } catch (failure) {
      if (failure instanceof NetworkError && failure.status === 429) throw new JobThrottledError(null);
      throw new Error('Job status could not be refreshed.');
    }
    return parseJobStatus(response, runId);
  },
};
