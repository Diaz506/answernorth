/** Browser-safe contracts. No decorated entities or credentials belong here. */
export interface TestCase {
  id: string;
  question: string;
  expectedAnswer: string;
  category: string;
  critical: boolean;
}

export interface Suite {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  cases: TestCase[];
  hash: string;
}

export interface Agent {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
}

export interface Workspace { id: string; name: string }

export interface SmokeRun {
  runId: string;
  notebookId: string | null;
  agentName: string;
  question: string;
  expectedAnswer: string;
  approvalHash: string;
  phase: 'ready' | 'submission-uncertain' | 'accepted' | 'running' | 'notebook-completed' | 'failed' | 'cancelled';
  jobId?: string;
  completedAt?: string;
  resultsVerified: false;
  message: string;
}

export interface SmokeEvidence {
  schemaVersion: 1;
  runId: string;
  jobId: string;
  evaluationId: string;
  resultId: string;
  agent: { id: string; name: string; workspaceId: string; workspaceName: string; stage: 'production' };
  completedAt: string;
  question: string;
  expectedAnswer: string;
  actualAnswer: string;
  outcome: 'passed' | 'failed' | 'unclear';
  judgeMessage: string;
  durationSeconds: number;
  counts: { passed: number; failed: number; unclear: number; total: 1 };
  verification: { filesHashVerified: 4; resultRows: 1; stepRows: number; resultStepLinked: true };
  links: { answer: string; grader: string };
}

export interface Bootstrap {
  workspace: Workspace;
  workspaces: Workspace[];
  suiteVersions: Suite[];
  runs: RunRecord[];
  capabilities: { cloudOnly: true; evaluationExecution: false };
  checkedAt: string;
  workspacesComplete: boolean;
  suitesComplete: boolean;
  runsComplete: boolean;
  executionBlocker: string;
  smokeRun?: SmokeRun;
}

export interface AgentsResponse { agents: Agent[]; complete: boolean; checkedAt: string }
export interface SaveSuiteResponse { suite: Suite }
export interface AgentProbe {
  workspaceId: string;
  agentId: string;
  checkedAt: string;
  reachable: boolean;
  publishedStage: 'unknown';
  tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[];
  error?: { code: string; message: string };
}
export interface ApiError { error: { code: string; message: string; retryAfterSeconds?: number } }
export interface SaveSuiteRequest {
  name: string;
  cases: Omit<TestCase, 'id'>[];
}

export interface RunSelection {
  workspaceId: string;
  agentId: string;
  suiteId: string;
  stage: 'production' | 'sandbox';
}

/** A read-only preparation, not an authorized or submitted evaluation run. */
export interface RunPreparation {
  schemaVersion: 1;
  target: Agent & { stage: RunSelection['stage']; publicationVerified: false };
  suite: Suite;
}

export interface RunRecord {
  id: string;
  requestId: string;
  target: RunPreparation['target'];
  suite: { id: string; name: string; version: number; hash: string; caseCount: number };
  createdAt: string;
  approvalDigest: string;
  status: 'awaiting_approval' | 'approved' | 'submission_uncertain' | 'job_accepted';
  approvedAt?: string;
  job?: RunJobReceipt;
}

export interface RunJobReceipt {
  workspaceId: string;
  notebookId: string;
  jobId: string;
  acceptedAt: string;
  firstPollAfterSeconds: number;
}

export interface NotebookJobObservation {
  state: 'job_not_started' | 'job_running' | 'job_completed_unverified' |
    'job_failed' | 'job_cancelled' | 'job_deduped';
  checkedAt: string;
  nextPollAfterSeconds: number | null;
}

/** Caller-owned immutable content, not a server-attested compliance audit. */
export interface ProofbenchRecord {
  id: string;
  owner_id: string;
  kind: string;
  suiteId?: string;
  createdAt: Date;
  payload: string;
}

export type UniversalAppSchema = { ProofbenchRecord: ProofbenchRecord };
