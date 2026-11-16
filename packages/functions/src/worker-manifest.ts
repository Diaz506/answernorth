import { createHmac } from 'node:crypto';
import type { Agent } from '@rayfin-app/shared';
import { prepareRun } from './run-preparation.js';
import { RunLedger, submissionClaimId } from './runs.js';
import { SafeError, uuid, type DeploymentConfig, type JobExecutionConfig } from './safety.js';
import { Suites, type Store } from './suites.js';

const PAYLOAD_LIMIT = 500_000;
const DOMAIN = 'answernorth-worker-manifest-v1\0';

function canonicalId(value: unknown): string {
  try {
    const parsed = uuid(value);
    if (parsed !== value) throw new Error();
    return parsed;
  } catch {
    throw new SafeError('CONFIGURATION_ERROR', 'The worker manifest configuration is invalid.');
  }
}

/**
 * Internal offline protocol prototype. This is not a dispatcher, an authorization
 * decision, or permission to replay an uncertain submission claim.
 */
export async function createWorkerManifest(
  store: Store,
  deployment: DeploymentConfig,
  execution: JobExecutionConfig,
  key: Buffer,
  runId: string,
  resolveAgent: (workspaceId: string, agentId: string) => Promise<Agent>,
): Promise<string> {
  const tenantId = canonicalId(deployment.tenantId);
  const appId = canonicalId(deployment.appId);
  const ownerId = canonicalId(deployment.ownerId);
  canonicalId(deployment.workspaceId);
  const workerWorkspaceId = canonicalId(execution.workspaceId);
  const workerNotebookId = canonicalId(execution.notebookId);
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new SafeError('CONFIGURATION_ERROR', 'The worker manifest key is invalid.');
  }
  const signingKey = Buffer.from(key);
  const ledger = new RunLedger(store, ownerId);
  const run = await ledger.get(uuid(runId));
  if (run.status !== 'submission_uncertain') {
    throw new SafeError('CLAIM_REQUIRED', 'The run must have an approved submission claim and no recorded job receipt.');
  }
  const suite = await new Suites(store, ownerId).getById(run.suite.id);
  const agent = await resolveAgent(run.target.workspaceId, run.target.id);
  const preparation = prepareRun({
    workspaceId: run.target.workspaceId, agentId: run.target.id,
    suiteId: run.suite.id, stage: run.target.stage,
  }, agent, suite);
  const claimed = await ledger.checkClaimed(run.id, run.approvalDigest, preparation);
  const binding = {
    tenantId, appId, ownerId, runId: claimed.id, attemptId: submissionClaimId(ownerId, claimed.id),
    approvalDigest: claimed.approvalDigest, workerWorkspaceId, workerNotebookId,
  };
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, binding, preparation }), 'utf8');
  if (payload.length > PAYLOAD_LIMIT) throw new SafeError('MANIFEST_TOO_LARGE', 'The worker manifest exceeds its size limit.');
  const mac = createHmac('sha256', signingKey).update(DOMAIN).update(payload).digest('hex');
  return JSON.stringify({ schemaVersion: 1, payload: payload.toString('base64url'), mac });
}
