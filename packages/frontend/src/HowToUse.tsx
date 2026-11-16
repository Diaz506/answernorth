import { BookOpen } from 'lucide-react';

export function HowToUse() {
  return <details className="pb-how-to">
    <summary><BookOpen size={18} aria-hidden="true" /> How to use AnswerNorth</summary>
    <div className="pb-how-to-content">
      <p>Prepare a test suite in three steps. Evaluation execution, historical evidence reads, and AI test generation are not available yet.</p>
      <ol>
        <li><h2>Choose an agent</h2><p>In Agents, select an accessible workspace and agent. Discovery uses the app owner’s Fabric permissions, not the viewer’s, and does not grant access. Changing workspace clears selections but keeps your draft in this session.</p></li>
        <li><h2>Prepare tests</h2><p>In Tests, select a saved version or create a suite with questions and trusted expected answers. AI is not configured; manual authoring and saved suites do not require it.</p></li>
        <li><h2>Save and review</h2><p>Save an immutable suite version, then review the selected agent, stage, questions, and expected answers. Unsaved suite edits are lost on reload. Explicitly create a durable run draft, then check the confirmation to approve the plan. Approval does not submit or execute an evaluation, and publication is not verified.</p></li>
      </ol>
      <p>Find owner-scoped run drafts from Tests via Review saved run drafts. Before creating a draft, this tab stores its request ID and selection IDs in session storage. If saving cannot be confirmed, reload to reconcile that request. If it is not found, restore the original selection to explicitly retry with the same request ID; no retry is automatic. A missing draft, even in a complete list, may still have been saved. If the selection cannot be restored or session storage is unavailable, contact your administrator. If approval cannot be confirmed, reload and check its status before trying again.</p>
      <p>For a saved run with a validated notebook job receipt, select Resume and review, then use Refresh job status explicitly. Refresh never starts a job or polls automatically. The button respects the receipt's initial delay and any later provider delay, including throttling; the next permitted time is kept per run in this tab's session storage. If timing cannot be safely saved or restored, or throttling has no valid delay, refresh is disabled and the job needs reconciliation. A completed job does not mean its results are verified.</p>
      <p>Results are empty until supported evaluation and evidence capabilities are available. No evaluation can be started from this interface.</p>
    </div>
  </details>;
}
