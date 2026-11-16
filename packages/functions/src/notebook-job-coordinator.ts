import type { RunPreparation, RunRecord } from '@rayfin-app/shared';
import { NotebookJobClient } from './notebook-job-client.js';
import { NotebookGuard } from './notebook-guard.js';
import { RunLedger, submissionClaimId, validApprovalDigest } from './runs.js';
import { SafeError } from './safety.js';
import type { Store } from './suites.js';

/**
 * Internal coordinator, not connected to a public submission path.
 * Runtime identity, publication, worker readiness and session revocation remain release gates.
 */
export class NotebookJobCoordinator {
  private readonly ledger: RunLedger;
  private readonly guard: NotebookGuard;

  constructor(store: Store, private readonly owner: string, private readonly client: NotebookJobClient, guardKey: Buffer,
    private readonly resolvePreparation: (run: RunRecord) => Promise<RunPreparation>) {
    this.ledger = new RunLedger(store, owner);
    this.guard = new NotebookGuard(store, owner, client, guardKey);
  }

  async submitOnce(runId: string, approvalDigest: string): Promise<RunRecord> {
    const saved = await this.ledger.get(runId);
    if (validApprovalDigest(approvalDigest) !== saved.approvalDigest) {
      throw new SafeError('RUN_STALE', 'The submitted digest does not match the approved run draft.');
    }
    if (saved.status !== 'approved') {
      throw new SafeError(saved.status === 'awaiting_approval' ? 'APPROVAL_REQUIRED' : 'RUN_ALREADY_CLAIMED',
        'The draft must be approved and have no existing submission claim.');
    }
    const preparation = await this.resolvePreparation(saved);
    const approved = await this.ledger.checkApproved(runId, approvalDigest, preparation);
    await this.client.assertNoRecentJobs();
    await this.guard.acquire(approved.id, approvalDigest);
    const attemptId = submissionClaimId(this.owner, approved.id);
    try {
      await this.client.assertNoRecentJobs();
      await this.ledger.claimSubmission(approved.id, approvalDigest);
    } catch (error) {
      const code = error instanceof SafeError ? error.code : 'SERVICE_UNAVAILABLE';
      throw new SafeError('GUARD_HELD_RECONCILE',
        `The notebook guard remains held; this attempt did not submit a job (${code}). Reconcile before retrying.`,
        error instanceof SafeError ? error.retryAfterSeconds : undefined);
    }
    const receipt = await this.client.submitOnce(approved.id, attemptId);
    return this.ledger.recordJobReceipt(approved.id, approvalDigest, receipt);
  }
}
