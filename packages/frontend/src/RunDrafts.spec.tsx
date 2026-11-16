import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { JobThrottledError, UncertainRunWriteError } from './services/proofbench.service';
import { pendingRunKey } from './services/pending-run';
import type { Bootstrap, ProofbenchService, RunRecord, Suite } from './services/proofbench.service';

const now = '2026-11-11T12:00:00Z';
const workspace = { id: '11111111-1111-4111-8111-111111111111', name: 'Fictional workspace' };
const agent = { id: 'agent-1', name: 'Fictional agent', workspaceId: workspace.id, workspaceName: workspace.name };
const suite: Suite = { id: 'suite-1', name: 'Fictional suite', version: 1, hash: 'hash-1', createdAt: now,
  cases: [{ id: 'case-1', question: 'Fictional question?', expectedAnswer: 'Fictional answer.', category: '', critical: true }] };
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const run: RunRecord = { id: 'run-1', requestId, target: { ...agent, stage: 'sandbox', publicationVerified: false },
  suite: { id: suite.id, name: suite.name, version: suite.version, hash: suite.hash, caseCount: 1 },
  createdAt: now, approvalDigest: 'digest-1', status: 'awaiting_approval' };
const bootstrap: Bootstrap = { workspace, workspaces: [workspace], suiteVersions: [suite], runs: [], runsComplete: true,
  checkedAt: now, workspacesComplete: true, suitesComplete: true, executionBlocker: 'Unavailable.',
  capabilities: { cloudOnly: true, evaluationExecution: false } };
function service(overrides: Partial<ProofbenchService> = {}): ProofbenchService {
  return { bootstrap: vi.fn().mockResolvedValue(bootstrap), listAgents: vi.fn().mockResolvedValue({ agents: [agent], complete: true, checkedAt: now }),
    saveSuite: vi.fn(), createRun: vi.fn().mockResolvedValue(run), approveRun: vi.fn().mockResolvedValue({ ...run, status: 'approved', approvedAt: now }), runStatus: vi.fn(), ...overrides };
}
async function prepare() {
  await screen.findByText('Fictional workspace');
  fireEvent.click(screen.getByRole('link', { name: 'Agents' }));
  fireEvent.click(await screen.findByRole('button', { name: /Fictional agent/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare tests' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select Fictional suite version 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review selections' }));
  fireEvent.change(screen.getByLabelText('Target stage'), { target: { value: 'sandbox' } });
}
beforeEach(() => { sessionStorage.clear(); vi.spyOn(crypto, 'randomUUID').mockReturnValue(requestId); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); window.history.replaceState(null, '', window.location.pathname); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('notebook job status', () => {
  const receipt = { workspaceId: workspace.id, notebookId: 'notebook-1', jobId: 'job-1', acceptedAt: now, firstPollAfterSeconds: 30 };
  const acceptedRun: RunRecord = { ...run, status: 'job_accepted', job: receipt };
  const observation = { state: 'job_completed_unverified' as const, checkedAt: now, nextPollAfterSeconds: null };
  async function reviewJob(api: ProofbenchService) {
    window.history.replaceState(null, '', '#review');
    render(<App service={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume and review' }));
  }
  it('only refreshes explicitly and reports completed as unverified, never executing', async () => {
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [acceptedRun], runsComplete: false }),
      runStatus: vi.fn().mockResolvedValue({ run: acceptedRun, job: observation }) });
    await reviewJob(api);
    expect(screen.getByText(/run draft list is partial/)).toBeVisible();
    expect(api.runStatus).not.toHaveBeenCalled();
    expect(screen.getByText(/Status has not been refreshed/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh job status' }));
    expect(await screen.findByText(/Job completed — not verified results/)).toBeVisible();
    expect(api.runStatus).toHaveBeenCalledOnce();
    expect(api.runStatus).toHaveBeenCalledWith(run.id);
    expect(api.createRun).not.toHaveBeenCalled();
    expect(api.approveRun).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Run evaluation' })).toBeDisabled();
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(api.runStatus).toHaveBeenCalledOnce();
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('link', { name: 'Tests' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review saved run drafts' }));
    expect(api.runStatus).toHaveBeenCalledOnce();
  });
  it.each([
    ['mismatched run', { run: { ...acceptedRun, id: 'other' }, job: observation }],
    ['invalid observation', { run: acceptedRun, job: { ...observation, state: 'invented' } }],
    ['different receipt', { run: { ...acceptedRun, job: { ...receipt, jobId: 'other' } }, job: observation }],
  ])('does not display %s', async (_label, payload) => {
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [acceptedRun] }),
      runStatus: vi.fn().mockResolvedValue(payload) });
    await reviewJob(api);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh job status' }));
    expect(await screen.findByText(/Job status could not be refreshed/)).toBeVisible();
    expect(screen.queryByText(/Job completed — not verified results/)).not.toBeInTheDocument();
    expect(api.runStatus).toHaveBeenCalledOnce();
  });
  it('hides provider errors and does not retry', async () => {
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [acceptedRun] }),
      runStatus: vi.fn().mockRejectedValue(new Error('private provider details')) });
    await reviewJob(api);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh job status' }));
    expect(await screen.findByText(/Job status could not be refreshed/)).toBeVisible();
    expect(screen.queryByText(/private provider details/)).not.toBeInTheDocument();
    expect(api.runStatus).toHaveBeenCalledOnce();
  });
  it('directs job configuration errors to the job workspace and notebook without exposing backend details', async () => {
    const failure = new Error('private configuration value'); failure.name = 'BackendConfigurationError';
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [acceptedRun] }),
      runStatus: vi.fn().mockRejectedValue(failure) });
    await reviewJob(api);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh job status' }));
    expect(await screen.findByText(/check the configured job workspace and notebook/)).toBeVisible();
    expect(screen.getByText(/ANSWERNORTH_JOB_WORKSPACE_ID and ANSWERNORTH_JOB_NOTEBOOK_ID/)).toBeVisible();
    expect(screen.queryByText(/private configuration value/)).not.toBeInTheDocument();
    expect(api.runStatus).toHaveBeenCalledOnce();
  });
  it('does not expose status controls without a valid receipt', async () => {
    const invalid = { ...acceptedRun, job: { ...receipt, jobId: '' } };
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [invalid] }) });
    await reviewJob(api);
    expect(screen.queryByRole('button', { name: 'Refresh job status' })).not.toBeInTheDocument();
    expect(api.runStatus).not.toHaveBeenCalled();
  });
  it('does not expose status controls to an unauthorized viewer', async () => {
    const denied = new Error('private access details'); denied.name = 'BackendAccessError';
    const api = service({ bootstrap: vi.fn().mockRejectedValue(denied) });
    window.history.replaceState(null, '', '#review');
    render(<App service={api} />);
    expect(await screen.findByText(/Access is restricted to the configured app owner and tenant/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Refresh job status' })).not.toBeInTheDocument();
    expect(api.runStatus).not.toHaveBeenCalled();
  });
  it('discards an in-flight observation when another run is selected', async () => {
    const second = { ...acceptedRun, id: 'run-2', job: { ...receipt, jobId: 'job-2' } };
    let finish: (value: { run: RunRecord; job: typeof observation }) => void = () => {};
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [acceptedRun, second] }),
      runStatus: vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; })) });
    await reviewJobForMultiple(api);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh job status' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Resume and review' })[1]);
    await act(async () => finish({ run: acceptedRun, job: observation }));
    expect(screen.queryByText(/Job completed — not verified results/)).not.toBeInTheDocument();
    expect(screen.getByText(/Status has not been refreshed/)).toBeVisible();
    expect(api.runStatus).toHaveBeenCalledOnce();
  });
  async function reviewJobForMultiple(api: ProofbenchService) {
    window.history.replaceState(null, '', '#review');
    render(<App service={api} />);
    const buttons = await screen.findAllByRole('button', { name: 'Resume and review' });
    fireEvent.click(buttons[0]);
  }

  it('enforces initial and follow-up deadlines without polling automatically', async () => {
    const observed = { state: 'job_running' as const, checkedAt: '2026-11-11T12:00:30Z', nextPollAfterSeconds: 45 };
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [acceptedRun] }),
      runStatus: vi.fn().mockResolvedValue({ run: acceptedRun, job: observed }) });
    window.history.replaceState(null, '', '#review');
    render(<App service={api} />);
    const resume = await screen.findByRole('button', { name: 'Resume and review' });
    vi.useFakeTimers(); vi.setSystemTime(new Date(now));
    fireEvent.click(resume);
    const refresh = screen.getByRole('button', { name: 'Refresh job status' });
    expect(refresh).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(refresh).toBeDisabled(); expect(api.runStatus).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(refresh).toBeEnabled(); expect(api.runStatus).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(refresh); });
    expect(api.runStatus).toHaveBeenCalledOnce(); expect(refresh).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(44_999); });
    expect(refresh).toBeDisabled(); expect(api.runStatus).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(refresh).toBeEnabled(); expect(api.runStatus).toHaveBeenCalledOnce();
  });

  it.each([0, null])('allows a manual follow-up with delay %s but never auto-polls', async (delay) => {
    const instant = { ...acceptedRun, job: { ...receipt, firstPollAfterSeconds: 0 } };
    const observed = { state: 'job_running' as const, checkedAt: now, nextPollAfterSeconds: delay };
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [instant] }),
      runStatus: vi.fn().mockResolvedValue({ run: instant, job: observed }) });
    window.history.replaceState(null, '', '#review');
    render(<App service={api} />);
    const resume = await screen.findByRole('button', { name: 'Resume and review' });
    vi.useFakeTimers(); vi.setSystemTime(new Date(now)); fireEvent.click(resume);
    const refresh = screen.getByRole('button', { name: 'Refresh job status' });
    expect(refresh).toBeEnabled();
    await act(async () => { fireEvent.click(refresh); });
    expect(refresh).toBeEnabled(); expect(api.runStatus).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.runStatus).toHaveBeenCalledOnce();
    await act(async () => { fireEvent.click(refresh); });
    expect(api.runStatus).toHaveBeenCalledTimes(2);
  });

  it('restores independent run deadlines after reload', async () => {
    const first = { ...acceptedRun, job: { ...receipt, firstPollAfterSeconds: 0 } };
    const second = { ...first, id: 'run-2', job: { ...first.job, jobId: 'job-2' } };
    const observed = { state: 'job_running' as const, checkedAt: now, nextPollAfterSeconds: 60 };
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [first, second] }),
      runStatus: vi.fn().mockResolvedValue({ run: first, job: observed }) });
    window.history.replaceState(null, '', '#review');
    const view = render(<App service={api} />);
    const buttons = await screen.findAllByRole('button', { name: 'Resume and review' });
    vi.useFakeTimers(); vi.setSystemTime(new Date(now)); fireEvent.click(buttons[0]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh job status' })); });
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeDisabled();
    view.unmount();
    await act(async () => { render(<App service={api} />); });
    const resumed = screen.getAllByRole('button', { name: 'Resume and review' });
    fireEvent.click(resumed[0]);
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeDisabled();
    fireEvent.click(resumed[1]);
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeEnabled();
    fireEvent.click(resumed[0]);
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeEnabled();
    expect(api.runStatus).toHaveBeenCalledOnce();
  });

  it('blocks refresh when session storage cannot preserve a returned delay', async () => {
    const instant = { ...acceptedRun, job: { ...receipt, firstPollAfterSeconds: 0 } };
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [instant] }),
      runStatus: vi.fn().mockResolvedValue({ run: instant, job: { state: 'job_running', checkedAt: now, nextPollAfterSeconds: 60 } }) });
    await reviewJob(api);
    const storage = sessionStorage;
    const storageWrite = vi.fn((key: string, value: string) => {
      if (key.startsWith('answernorth.job-poll.') && value !== '9999-12-31T23:59:59.999Z') throw new Error('Storage unavailable');
      storage.setItem(key, value);
    });
    vi.stubGlobal('sessionStorage', { getItem: storage.getItem.bind(storage), setItem: storageWrite });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh job status' })); });
    expect(api.runStatus).toHaveBeenCalledOnce();
    expect(storageWrite).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Refresh timing cannot be safely restored/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeDisabled();
    cleanup();
    await reviewJob(api);
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeDisabled();
    expect(api.runStatus).toHaveBeenCalledOnce();
  });
  it('does not request status when the in-flight marker cannot be saved', async () => {
    const instant = { ...acceptedRun, job: { ...receipt, firstPollAfterSeconds: 0 } };
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [instant] }) });
    await reviewJob(api);
    const storage = sessionStorage;
    vi.stubGlobal('sessionStorage', { getItem: storage.getItem.bind(storage), setItem: () => {} });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh job status' }));
    expect(api.runStatus).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeDisabled();
    expect(screen.getByText(/Refresh timing cannot be safely restored/)).toBeVisible();
  });
  it('blocks refresh when a stored deadline is invalid', async () => {
    sessionStorage.setItem('answernorth.job-poll.v1:run-1', 'invalid');
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [acceptedRun] }) });
    await reviewJob(api);
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeDisabled();
    expect(screen.getByText(/Refresh timing cannot be safely restored/)).toBeVisible();
    expect(api.runStatus).not.toHaveBeenCalled();
  });
  it('blocks refresh after reload while a previous request is unresolved', async () => {
    const instant = { ...acceptedRun, job: { ...receipt, firstPollAfterSeconds: 0 } };
    let finish: (value: { run: RunRecord; job: typeof observation }) => void = () => {};
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [instant] }),
      runStatus: vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; })) });
    await reviewJob(api);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh job status' }));
    cleanup();
    await reviewJob(api);
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeDisabled();
    expect(api.runStatus).toHaveBeenCalledOnce();
    await act(async () => finish({ run: instant, job: observation }));
  });
  it('persists a throttling delay across reload and never retries automatically', async () => {
    const instant = { ...acceptedRun, job: { ...receipt, firstPollAfterSeconds: 0 } };
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [instant] }),
      runStatus: vi.fn().mockRejectedValue(new JobThrottledError(45)) });
    window.history.replaceState(null, '', '#review');
    const view = render(<App service={api} />);
    const resume = await screen.findByRole('button', { name: 'Resume and review' });
    vi.useFakeTimers(); vi.setSystemTime(new Date(now)); fireEvent.click(resume);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh job status' })); });
    expect(api.runStatus).toHaveBeenCalledOnce();
    expect(screen.getByText(/Job status was throttled. Only refresh manually/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeDisabled();
    view.unmount();
    await act(async () => { render(<App service={api} />); });
    fireEvent.click(screen.getByRole('button', { name: 'Resume and review' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(44_999); });
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeEnabled();
    expect(api.runStatus).toHaveBeenCalledOnce();
  });
  it.each([undefined, -1, 86401, '10'])('requires reconciliation for missing or invalid throttling delay %s', async (delay) => {
    const instant = { ...acceptedRun, job: { ...receipt, firstPollAfterSeconds: 0 } };
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [instant] }),
      runStatus: vi.fn().mockRejectedValue(new JobThrottledError(delay)) });
    await reviewJob(api);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh job status' })); });
    expect(screen.getByText(/throttled without a valid retry delay/)).toBeVisible();
    expect(screen.getByText(/reconcile the job status and contact your administrator/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeDisabled();
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(172_800_000); });
    expect(api.runStatus).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeDisabled();
    vi.useRealTimers();
    cleanup();
    await reviewJob(api);
    expect(screen.getByText(/throttled without a valid retry delay/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeDisabled();
    expect(api.runStatus).toHaveBeenCalledOnce();
  });
  it('honors a zero-second throttle delay without automatically retrying', async () => {
    const instant = { ...acceptedRun, job: { ...receipt, firstPollAfterSeconds: 0 } };
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [instant] }),
      runStatus: vi.fn().mockRejectedValue(new JobThrottledError(0)) });
    await reviewJob(api);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh job status' })); });
    expect(screen.getByRole('button', { name: 'Refresh job status' })).toBeEnabled();
    expect(api.runStatus).toHaveBeenCalledOnce();
  });
});

describe('durable draft plans', () => {
  it('creates a frozen plan and requires explicit confirmation before approval', async () => {
    const api = service(); render(<App service={api} />); await prepare();
    expect(within(screen.getByRole('region', { name: 'Selection review' })).getByText('Fictional question?')).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Selection review' })).getByText(/Fictional answer\./)).toBeVisible();
    expect(screen.getByText(/Approval is for the plan only/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft record' }));
    const approve = await screen.findByRole('button', { name: 'Approve draft plan' });
    expect(approve).toBeDisabled(); expect(api.approveRun).not.toHaveBeenCalled();
    expect(api.createRun).toHaveBeenCalledTimes(1);
    expect(api.createRun).toHaveBeenCalledWith({ workspaceId: workspace.id, agentId: agent.id, suiteId: suite.id, stage: 'sandbox' }, expect.any(String));
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed the exact questions/ }));
    fireEvent.click(approve);
    await waitFor(() => expect(api.approveRun).toHaveBeenCalledWith(run.id, run.approvalDigest));
    await waitFor(() => expect(screen.getByText(/Status:/)).toHaveTextContent('approved'));
    expect(approve).toBeDisabled(); expect(screen.getByRole('button', { name: 'Run evaluation' })).toBeDisabled();
  });
  it('never retries or allows a second create after an uncertain failure, even after navigation', async () => {
    const api = service({ createRun: vi.fn().mockRejectedValue(new UncertainRunWriteError('create')) }); render(<App service={api} />); await prepare();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft record' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reload this page');
    expect(screen.getByRole('alert')).toHaveTextContent('The draft save may have completed.');
    expect(screen.getByRole('alert')).toHaveTextContent('reconcile the saved request');
    expect(screen.queryByText(/private error/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create draft record' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit or select tests' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review selections' }));
    expect(screen.getByRole('button', { name: 'Create draft record' })).toBeDisabled(); expect(api.createRun).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(pendingRunKey) ?? '{}')).toEqual({
      requestId, selection: { workspaceId: workspace.id, agentId: agent.id, suiteId: suite.id, stage: 'sandbox' },
    });
  });
  it('reconciles by request ID after reload, distinguishing otherwise identical drafts', async () => {
    const first = service({ createRun: vi.fn().mockRejectedValue(new UncertainRunWriteError('create')) });
    const view = render(<App service={first} />); await prepare();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft record' }));
    await screen.findByRole('alert');
    view.unmount();
    const similar = { ...run, id: 'run-2', requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    const reloaded = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [similar, run] }) });
    window.history.replaceState(null, '', '#review');
    render(<App service={reloaded} />);
    expect(await screen.findByText(/pending request was matched/)).toBeVisible();
    expect(sessionStorage.getItem(pendingRunKey)).toBeNull();
    expect(reloaded.createRun).not.toHaveBeenCalled();
    expect(reloaded.approveRun).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Resume and review recovered draft' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resume and review' })).toBeVisible();
  });
  it.each([true, false])('keeps a missing request uncertain for complete=%s and explicitly retries with the same ID', async (complete) => {
    const first = service({ createRun: vi.fn().mockRejectedValue(new UncertainRunWriteError('create')) });
    const view = render(<App service={first} />); await prepare();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft record' }));
    await screen.findByRole('alert'); view.unmount();
    const reloaded = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [], runsComplete: complete }) });
    window.history.replaceState(null, '', '#review');
    render(<App service={reloaded} />);
    expect(await screen.findByText(/previous draft request remains uncertain/)).toBeVisible();
    expect(screen.getByText(/pending request may still have been saved/)).toBeVisible();
    expect(reloaded.createRun).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create draft record' })).toBeDisabled();
    const restore = await screen.findByRole('button', { name: 'Restore pending selection' });
    await waitFor(() => expect(restore).toBeEnabled());
    fireEvent.click(restore);
    fireEvent.click(screen.getByRole('button', { name: 'Retry pending draft request' }));
    await waitFor(() => expect(reloaded.createRun).toHaveBeenCalledTimes(1));
    expect(reloaded.createRun).toHaveBeenCalledWith({ workspaceId: workspace.id, agentId: agent.id, suiteId: suite.id, stage: 'sandbox' }, requestId);
    await waitFor(() => expect(sessionStorage.getItem(pendingRunKey)).toBeNull());
    expect(reloaded.approveRun).not.toHaveBeenCalled();
  });
  it('does not reconcile an otherwise identical draft with a different request ID', async () => {
    sessionStorage.setItem(pendingRunKey, JSON.stringify({ requestId, selection: {
      workspaceId: workspace.id, agentId: agent.id, suiteId: suite.id, stage: 'sandbox',
    } }));
    const similar = { ...run, id: 'run-2', requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [similar], runsComplete: false }) });
    window.history.replaceState(null, '', '#review'); render(<App service={api} />);
    expect(await screen.findByText(/previous draft request remains uncertain/)).toBeVisible();
    expect(sessionStorage.getItem(pendingRunKey)).not.toBeNull();
    expect(screen.queryByText(/pending request was matched/)).not.toBeInTheDocument();
    expect(api.createRun).not.toHaveBeenCalled();
  });
  it('fails closed on a malformed stored request without discarding it', async () => {
    sessionStorage.setItem(pendingRunKey, '{"requestId":"invalid","question":"private"}');
    const api = service(); window.history.replaceState(null, '', '#review'); render(<App service={api} />);
    expect(await screen.findByText(/Draft recovery is blocked/)).toBeVisible();
    expect(sessionStorage.getItem(pendingRunKey)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Create draft record' })).toBeDisabled();
    expect(api.createRun).not.toHaveBeenCalled();
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
  });
  it('does not reconcile a request ID whose returned selection conflicts', async () => {
    sessionStorage.setItem(pendingRunKey, JSON.stringify({ requestId, selection: {
      workspaceId: workspace.id, agentId: agent.id, suiteId: 'other-suite', stage: 'sandbox',
    } }));
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [run] }) });
    window.history.replaceState(null, '', '#review'); render(<App service={api} />);
    expect(await screen.findByText(/Draft recovery is blocked/)).toBeVisible();
    expect(sessionStorage.getItem(pendingRunKey)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Create draft record' })).toBeDisabled();
    expect(api.createRun).not.toHaveBeenCalled();
  });
  it('blocks further writes if the completed request cannot be removed from session storage', async () => {
    let value: string | null = null;
    vi.stubGlobal('sessionStorage', {
      getItem: () => value,
      setItem: (_key: string, raw: string) => { value = raw; },
      removeItem: () => { throw new Error('private storage'); },
    });
    const api = service(); render(<App service={api} />); await prepare();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft record' }));
    expect(await screen.findByText(/session storage could not be cleared/)).toBeVisible();
    expect(value).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Create draft record' })).toBeDisabled();
    expect(api.createRun).toHaveBeenCalledTimes(1);
    expect(api.approveRun).not.toHaveBeenCalled();
  });
  it('blocks new drafts if session storage cannot be read or written', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('private storage'); } });
    const api = service(); const view = render(<App service={api} />); await prepare();
    expect(screen.getByText(/Draft recovery is blocked/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create draft record' })).toBeDisabled();
    expect(api.createRun).not.toHaveBeenCalled();
    view.unmount(); vi.unstubAllGlobals();
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => { throw new Error('private storage'); } });
    window.history.replaceState(null, '', window.location.pathname);
    render(<App service={api} />); await prepare();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft record' }));
    expect(await screen.findByText(/No draft request was sent/)).toBeVisible();
    expect(api.createRun).not.toHaveBeenCalled();
    expect(screen.queryByText(/private storage/)).not.toBeInTheDocument();
  });
  it('does not retry a pending request in a different workspace', async () => {
    sessionStorage.setItem(pendingRunKey, JSON.stringify({ requestId, selection: {
      workspaceId: workspace.id, agentId: agent.id, suiteId: suite.id, stage: 'sandbox',
    } }));
    const other = { id: '22222222-2222-4222-8222-222222222222', name: 'Other workspace' };
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, workspaces: [other, workspace] }) });
    window.history.replaceState(null, '', '#review'); render(<App service={api} />);
    expect(await screen.findByText(/previous draft request remains uncertain/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restore pending selection' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry pending draft request' })).toBeDisabled();
    expect(api.createRun).not.toHaveBeenCalled();
  });
  it('warns when the original pending selection cannot be restored', async () => {
    sessionStorage.setItem(pendingRunKey, JSON.stringify({ requestId, selection: {
      workspaceId: workspace.id, agentId: agent.id, suiteId: 'missing-suite', stage: 'sandbox',
    } }));
    const api = service(); window.history.replaceState(null, '', '#review'); render(<App service={api} />);
    expect(await screen.findByText(/original selection cannot be restored/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry pending draft request' })).toBeDisabled();
    expect(sessionStorage.getItem(pendingRunKey)).not.toBeNull();
    expect(api.createRun).not.toHaveBeenCalled();
  });
  it('locks approval after an uncertain response without retry', async () => {
    const api = service({ approveRun: vi.fn().mockRejectedValue(new UncertainRunWriteError('approve')) }); render(<App service={api} />); await prepare();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft record' }));
    await screen.findByRole('button', { name: 'Approve draft plan' });
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed the exact questions/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve draft plan' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reload this page');
    expect(screen.getByRole('alert')).toHaveTextContent('The approval may have completed.');
    expect(screen.getByRole('button', { name: 'Approve draft plan' })).toBeDisabled(); expect(api.approveRun).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/private approval error/)).not.toBeInTheDocument();
  });
  it('recovers persisted records only after explicit resume and blocks mismatched selections', async () => {
    const other = { ...suite, id: 'suite-2', name: 'Other suite', hash: 'hash-2' };
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, suiteVersions: [suite, other], runs: [run], runsComplete: false }) });
    render(<App service={api} />); await screen.findByText('Fictional workspace');
    fireEvent.click(screen.getByRole('link', { name: 'Tests' })); fireEvent.click(screen.getByRole('button', { name: 'Review saved run drafts' }));
    expect(screen.getByText(/run draft list is partial/)).toBeVisible();
    expect(api.approveRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Resume and review' }));
    await waitFor(() => expect(screen.getByLabelText('Target stage')).toHaveValue('sandbox'));
    expect(within(screen.getByRole('region', { name: 'Selection review' })).getByText('Fictional question?')).toBeVisible();
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed the exact questions/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit or select tests' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Other suite version 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review selections' }));
    expect(screen.getByText(/Current selections do not match/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve draft plan' })).toBeDisabled();
    expect(api.approveRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit or select tests' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Fictional suite version 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review selections' }));
    expect(screen.getByRole('checkbox', { name: /I reviewed the exact questions/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Approve draft plan' })).toBeDisabled();
    expect(api.approveRun).not.toHaveBeenCalled();
  });
  it('requires a new confirmation after changing the target stage away and back', async () => {
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [run] }) });
    render(<App service={api} />); await prepare();
    fireEvent.click(screen.getByRole('button', { name: 'Resume and review' }));
    const checkbox = screen.getByRole('checkbox', { name: /I reviewed the exact questions/ });
    fireEvent.click(checkbox);
    expect(screen.getByRole('button', { name: 'Approve draft plan' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Target stage'), { target: { value: 'production' } });
    fireEvent.change(screen.getByLabelText('Target stage'), { target: { value: 'sandbox' } });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Approve draft plan' })).toBeDisabled();
    expect(api.approveRun).not.toHaveBeenCalled();
  });
  it('blocks double clicks while create is in flight', async () => {
    let finish: (value: RunRecord) => void = () => {};
    const api = service({ createRun: vi.fn().mockImplementation(() => new Promise<RunRecord>((resolve) => { finish = resolve; })) });
    render(<App service={api} />); await prepare();
    const create = screen.getByRole('button', { name: 'Create draft record' });
    fireEvent.click(create); fireEvent.click(create); expect(api.createRun).toHaveBeenCalledTimes(1);
    await act(async () => finish(run));
    expect(await screen.findByRole('button', { name: 'Approve draft plan' })).toBeDisabled();
  });
  it('treats a timed-out create as uncertain and ignores a late acknowledgement', async () => {
    let finish: (value: RunRecord) => void = () => {};
    const api = service({ createRun: vi.fn().mockImplementation(() => new Promise<RunRecord>((resolve) => { finish = resolve; })) });
    render(<App service={api} />); await prepare(); vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft record' }));
    await act(async () => { vi.advanceTimersByTime(25000); });
    expect(screen.getByRole('alert')).toHaveTextContent('Reload this page');
    await act(async () => finish(run));
    expect(screen.getByRole('button', { name: 'Create draft record' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Approve draft plan' })).not.toBeInTheDocument();
    expect(api.createRun).toHaveBeenCalledTimes(1);
  });
  it('does not resume a frozen draft when the stored suite hash differs', async () => {
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, suiteVersions: [{ ...suite, hash: 'changed' }], runs: [run] }) });
    render(<App service={api} />); await screen.findByText('Fictional workspace');
    fireEvent.click(screen.getByRole('link', { name: 'Tests' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review saved run drafts' }));
    await waitFor(() => expect(api.listAgents).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Resume and review' }));
    expect(screen.getByRole('alert')).toHaveTextContent('unavailable or does not match');
    expect(screen.getByRole('button', { name: 'Approve draft plan' })).toBeDisabled();
    expect(api.approveRun).not.toHaveBeenCalled();
  });
  it('does not interpret an empty partial draft list as proof that no draft was saved', async () => {
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [], runsComplete: false }) });
    render(<App service={api} />); await screen.findByText('Fictional workspace');
    fireEvent.click(screen.getByRole('link', { name: 'Tests' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review saved run drafts' }));
    expect(screen.getByText(/a draft missing from this list may still have been saved/)).toBeVisible();
    expect(screen.getByText('No run drafts were returned in this partial list.')).toBeVisible();
    expect(screen.queryByText('No saved run drafts yet.')).not.toBeInTheDocument();
  });
  it('clears the selection and prevents approval when the workspace changes', async () => {
    const second = { id: '22222222-2222-4222-8222-222222222222', name: 'Other workspace' };
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, workspaces: [workspace, second], runs: [run] }) });
    render(<App service={api} />); await prepare();
    fireEvent.click(screen.getByRole('button', { name: 'Resume and review' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed the exact questions/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Change agent' }));
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: second.id } });
    await screen.findByText(/Discovery complete/);
    fireEvent.click(screen.getByRole('link', { name: 'Tests' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review saved run drafts' }));
    expect(screen.getByText(/Current selections do not match/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve draft plan' })).toBeDisabled();
    expect(api.approveRun).not.toHaveBeenCalled();
  });
  it('locks approval after a timeout and ignores a late acknowledgement', async () => {
    let finish: (value: RunRecord) => void = () => {};
    const api = service({ approveRun: vi.fn().mockImplementation(() => new Promise<RunRecord>((resolve) => { finish = resolve; })) });
    render(<App service={api} />); await prepare();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft record' }));
    await screen.findByRole('button', { name: 'Approve draft plan' });
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed the exact questions/ }));
    vi.useFakeTimers(); fireEvent.click(screen.getByRole('button', { name: 'Approve draft plan' }));
    await act(async () => { vi.advanceTimersByTime(25000); });
    expect(screen.getByRole('alert')).toHaveTextContent('Reload this page');
    await act(async () => finish({ ...run, status: 'approved', approvedAt: now }));
    expect(screen.getByText(/Status:/)).toHaveTextContent('awaiting approval');
    expect(screen.getByRole('button', { name: 'Approve draft plan' })).toBeDisabled();
    expect(api.approveRun).toHaveBeenCalledTimes(1);
  });
  it('displays the internal uncertain claim without offering a submission action', async () => {
    const api = service({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, runs: [{ ...run, status: 'submission_uncertain', approvedAt: now }] }) });
    render(<App service={api} />); await prepare();
    fireEvent.click(screen.getByRole('button', { name: 'Resume and review' }));
    expect(screen.getByText(/An internal claim is unresolved/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve draft plan' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run evaluation' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
  });
});
