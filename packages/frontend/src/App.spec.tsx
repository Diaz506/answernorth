import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { ThemeContext } from './hooks/theme.context';
import type { Bootstrap, ProofbenchService, Suite } from './services/proofbench.service';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const secondWorkspaceId = '22222222-2222-4222-8222-222222222222';
const bootstrap: Bootstrap = {
  workspace: { id: workspaceId, name: 'Fictional app workspace' },
  workspaces: [{ id: workspaceId, name: 'Fictional workspace A' }, { id: secondWorkspaceId, name: 'Fictional workspace B' }],
  suiteVersions: [], runs: [],
  capabilities: { cloudOnly: true, evaluationExecution: false },
  checkedAt: '2026-11-11T12:00:00Z',
  workspacesComplete: true, suitesComplete: true, runsComplete: true,
  executionBlocker: 'Cloud evaluation execution is not configured in this release.',
};

function createService(overrides: Partial<ProofbenchService> = {}): ProofbenchService {
  return {
    bootstrap: vi.fn().mockResolvedValue(bootstrap),
    listAgents: vi.fn().mockResolvedValue({ agents: [], complete: true, checkedAt: bootstrap.checkedAt }),
    saveSuite: vi.fn(),
    createRun: vi.fn(),
    approveRun: vi.fn(),
    runStatus: vi.fn(),
    ...overrides,
  };
}

async function open(page: string) {
  await screen.findByText('Fictional app workspace');
  fireEvent.click(screen.getByRole('link', { name: page }));
}

function fillCase() {
  fireEvent.change(screen.getByLabelText('Suite name'), { target: { value: 'Fictional checks' } });
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'What color is the fictional marker?' } });
  fireEvent.change(screen.getByLabelText('Expected answer'), { target: { value: 'The fictional marker is blue.' } });
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', window.location.pathname);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Proofbench', () => {
  it('defaults to empty results with only three destinations and no execution controls', async () => {
    const service = createService();
    render(<App service={service} />);
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to your cloud workspace');
    await screen.findByRole('heading', { name: 'No results available' });
    const brand = screen.getByRole('link', { name: 'AnswerNorth results' });
    expect(brand.querySelector('.answer-north-mark')).toHaveAttribute('aria-hidden', 'true');
    await waitFor(() => expect(service.listAgents).toHaveBeenCalledWith(workspaceId));
    expect(screen.getByRole('navigation').querySelectorAll('a')).toHaveLength(3);
    expect(screen.getByText(/Access is restricted to the configured application owner and tenant/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Results' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: /run|submit/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/accuracy|pass rate|success rate/i)).not.toBeInTheDocument();
  });

  it('surfaces a sanitized bootstrap error and supports retry', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('private service token')).mockResolvedValue(bootstrap);
    render(<App service={createService({ bootstrap: load })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Check configuration and workspace permissions');
    expect(screen.queryByText('private service token')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    await screen.findByRole('heading', { name: 'No results available' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('explains missing backend configuration without exposing private error details', async () => {
    const failure = Object.assign(new Error('private configuration value'), { name: 'MissingRayfinConfigError' });
    render(<App service={createService({ bootstrap: vi.fn().mockRejectedValue(failure) })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('configure the service URL and publishable key');
    expect(screen.queryByText(/private configuration value/)).not.toBeInTheDocument();
  });

  it('explains backend configuration and owner access errors without leaking provider text', async () => {
    const failure = Object.assign(new Error('private backend value'), { name: 'BackendConfigurationError' });
    const load = vi.fn().mockRejectedValueOnce(failure).mockRejectedValueOnce(Object.assign(new Error('private identity'), { name: 'BackendAccessError' }));
    render(<App service={createService({ bootstrap: load })} />);
    const alert = await screen.findByRole('alert');
    for (const setting of ['ANSWERNORTH_TENANT_ID', 'ANSWERNORTH_WORKSPACE_ID', 'ANSWERNORTH_APP_ID', 'ANSWERNORTH_OWNER_ID']) {
      expect(alert).toHaveTextContent(setting);
    }
    expect(screen.queryByText(/private backend value/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('configured app owner and tenant');
    expect(screen.queryByText(/private identity/)).not.toBeInTheDocument();
  });

  it('navigates without hidden AI, evidence, agent execution, or evaluation calls', async () => {
    const forbidden = vi.fn();
    const service = { ...createService(), smokeEvidence: forbidden, generate: forbidden, execute: forbidden, evaluate: forbidden };
    render(<App service={service} />);
    await screen.findByRole('heading', { name: 'No results available' });
    fireEvent.click(screen.getByRole('button', { name: 'Start preparing' }));
    await open('Tests');
    await open('Results');
    expect(forbidden).not.toHaveBeenCalled();
    expect(service.saveSuite).not.toHaveBeenCalled();
    expect(screen.queryByText(/passed|pass rate|accuracy/i)).not.toBeInTheDocument();
  });

  it('ignores stale workspace inventory failures after the workspace changes', async () => {
    let rejectOld: ((reason: Error) => void) | undefined;
    const listAgents = vi.fn().mockImplementation((id: string) => id === workspaceId
      ? new Promise((_, reject) => { rejectOld = reject; })
      : Promise.resolve({ agents: [], complete: true, checkedAt: bootstrap.checkedAt }));
    render(<App service={createService({ listAgents })} />);
    await open('Agents');
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: secondWorkspaceId } });
    await screen.findByText('No data agents found');
    await act(async () => rejectOld?.(new Error('stale private failure')));
    expect(screen.queryByText(/stale private failure/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('bounds a hanging cloud request instead of spinning indefinitely', async () => {
    vi.useFakeTimers();
    render(<App service={createService({ bootstrap: () => new Promise(() => {}) })} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(25001); });
    expect(screen.getByRole('alert')).toHaveTextContent('took too long');
    expect(screen.queryByText('Connecting to your cloud workspace…')).not.toBeInTheDocument();
  });

  it('discovers the chosen workspace, filters agents, and selects an exact target', async () => {
    const listAgents = vi.fn().mockImplementation(async (id: string) => ({
      agents: id === secondWorkspaceId ? [{ id: 'real-agent-id', name: 'Authorized inventory agent', workspaceId: id, workspaceName: 'Fictional workspace B' }] : [],
      complete: true, checkedAt: bootstrap.checkedAt,
    }));
    render(<App service={createService({ listAgents })} />);
    await open('Agents');
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: secondWorkspaceId } });
    fireEvent.click(await screen.findByRole('button', { name: /Authorized inventory agent/ }));
    expect(screen.getByRole('heading', { name: 'Authorized inventory agent' })).toBeInTheDocument();
    expect(listAgents).toHaveBeenLastCalledWith(secondWorkspaceId);
    expect(screen.getByText('real-agent-id').closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare tests' }));
    expect(screen.getByLabelText('Suite name')).toBeVisible();
  });

  it('validates manually selected workspace IDs without making an unauthorized request', async () => {
    const service = createService();
    render(<App service={service} />);
    await open('Agents');
    fireEvent.click(screen.getByText('Workspace and access details'));
    fireEvent.change(screen.getByLabelText('Or enter a workspace ID'), { target: { value: 'not-an-id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discover workspace' }));
    expect(screen.getByRole('alert')).toHaveTextContent('valid Fabric workspace UUID');
    expect(service.listAgents).not.toHaveBeenCalledWith('not-an-id');
  });

  it('surfaces agent discovery errors and retries without substituting sample agents', async () => {
    const listAgents = vi.fn().mockRejectedValueOnce(new Error('forbidden')).mockResolvedValue({
      agents: [], complete: true, checkedAt: bootstrap.checkedAt,
    });
    render(<App service={createService({ listAgents })} />);
    await open('Agents');
    expect(await screen.findByRole('alert')).toHaveTextContent('workspace permissions');
    fireEvent.click(screen.getByRole('button', { name: 'Retry discovery' }));
    expect(await screen.findByText('No data agents found')).toBeInTheDocument();
  });

  it('validates suite fields before calling the cloud service', async () => {
    const service = createService();
    render(<App service={service} />);
    await open('Tests');
    fireEvent.click(screen.getByRole('button', { name: 'Save immutable version' }));
    expect(screen.getByText('A suite name is required.')).toBeInTheDocument();
    expect(screen.getByText('Question is required.')).toBeInTheDocument();
    expect(screen.getByText('Expected answer is required.')).toBeInTheDocument();
    expect(service.saveSuite).not.toHaveBeenCalled();
  });

  it('enforces the MVP question, answer, and category size limits', async () => {
    const service = createService();
    render(<App service={service} />);
    await open('Tests');
    fillCase();
    expect(screen.getByLabelText('Question')).toHaveAttribute('maxlength', '1000');
    expect(screen.getByLabelText('Expected answer')).toHaveAttribute('maxlength', '1500');
    expect(screen.getByLabelText(/Category/)).toHaveAttribute('maxlength', '80');
    expect(screen.getByText(/Up to 30 cases per version/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'x'.repeat(1001) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save immutable version' }));
    expect(screen.getByText('Question must be 1,000 characters or fewer.')).toBeInTheDocument();
    expect(service.saveSuite).not.toHaveBeenCalled();
  });

  it('waits for the cloud save acknowledgement and preserves the draft across navigation', async () => {
    let resolveSave: ((value: Suite) => void) | undefined;
    const saveSuite = vi.fn().mockImplementation(() => new Promise<Suite>((resolve) => { resolveSave = resolve; }));
    render(<App service={createService({ saveSuite })} />);
    await open('Tests');
    fillCase();
    fireEvent.click(screen.getByLabelText(/Critical case/));
    fireEvent.change(screen.getByLabelText(/Category/), { target: { value: '  Fictional category  ' } });
    await open('Results');
    await open('Tests');
    expect(screen.getByLabelText('Question')).toHaveValue('What color is the fictional marker?');
    fireEvent.click(screen.getByRole('button', { name: 'Save immutable version' }));
    expect(screen.getByRole('button', { name: 'Saving to cloud…' })).toBeDisabled();
    expect(screen.queryByText(/Saved “Fictional checks”/)).not.toBeInTheDocument();
    const payload = saveSuite.mock.calls[0]?.[0];
    expect(payload.cases[0]).toMatchObject({ question: 'What color is the fictional marker?', category: 'Fictional category', critical: true });
    await act(async () => { resolveSave?.({ id: 'suite-v1', name: payload.name, version: 1, cases: payload.cases, createdAt: bootstrap.checkedAt, hash: 'verified-hash' }); });
    expect(await screen.findByText(/Saved “Fictional checks” version 1 to the cloud/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use as draft' })).toBeInTheDocument();
  });

  it('does not claim persistence after a rejected save', async () => {
    render(<App service={createService({ saveSuite: vi.fn().mockRejectedValue(new Error('save failed')) })} />);
    await open('Tests');
    fillCase();
    fireEvent.click(screen.getByRole('button', { name: 'Save immutable version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your draft is still here');
    expect(screen.getByLabelText('Question')).toHaveValue('What color is the fictional marker?');
    expect(screen.getByText('UNSAVED DRAFT')).toBeInTheDocument();
    expect(screen.queryByText(/Saved “/)).not.toBeInTheDocument();
  });

  it('reloads a saved cloud version into an editable draft without mutating that version', async () => {
    const suite: Suite = {
      id: 'saved-v2', name: 'Saved tests', version: 2, hash: 'verified-hash', createdAt: bootstrap.checkedAt,
      cases: [{ id: 'saved-case', question: 'Saved question?', expectedAnswer: 'Saved answer.', category: 'Totals', critical: true }],
    };
    const service = createService({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, suiteVersions: [suite] }) });
    const view = render(<App service={service} />);
    await open('Tests');
    expect(screen.getByText('Create or edit a test suite', { selector: 'summary' }).closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Review 1 test'));
    expect(screen.getByText('Saved question?', { selector: 'h3' })).toBeVisible();
    expect(service.saveSuite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use as draft' }));
    expect(screen.getByLabelText('Question')).toHaveValue('Saved question?');
    expect(screen.getByLabelText('Expected answer')).toHaveValue('Saved answer.');
    expect(screen.getByLabelText(/Critical case/)).toBeChecked();
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'New draft question?' } });
    expect(suite.cases[0].question).toBe('Saved question?');
    view.unmount();
    render(<App service={service} />);
    await open('Tests');
    fireEvent.click(screen.getByRole('button', { name: 'Use as draft' }));
    expect(screen.getByLabelText('Question')).toHaveValue('Saved question?');
    expect(service.bootstrap).toHaveBeenCalledTimes(2);
    expect(service.saveSuite).not.toHaveBeenCalled();
  });

  it.each(['overview', 'runs', 'compare', 'suites'])('preserves legacy #%s deep links', async (hash) => {
    window.history.replaceState(null, '', `#${hash}`);
    render(<App service={createService()} />);
    await screen.findByText('Fictional app workspace');
    expect(screen.getByRole('link', { name: hash === 'suites' ? 'Tests' : 'Results' })).toHaveAttribute('aria-current', 'page');
  });

  it('lets keyboard users skip to the current page without changing destinations', async () => {
    render(<App service={createService()} />);
    await open('Tests');
    fireEvent.click(screen.getByRole('link', { name: 'Skip to content' }));
    expect(screen.getByRole('main')).toHaveFocus();
    expect(screen.getByRole('link', { name: 'Tests' })).toHaveAttribute('aria-current', 'page');
    expect(window.location.hash).toBe('#tests');
  });

  it('renders agent and suite values as inert text, never executable markup', async () => {
    const malicious = '<img src=x onerror=alert(1)>';
    render(<App service={createService({
      listAgents: vi.fn().mockResolvedValue({ agents: [{ id: 'agent', name: malicious, workspaceId, workspaceName: 'Fictional workspace A' }], complete: true, checkedAt: bootstrap.checkedAt }),
    })} />);
    await open('Agents');
    expect(await screen.findByText(malicious)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    await open('Tests');
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: malicious } });
    expect(screen.getByText(malicious, { selector: 'strong' })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('uses the existing theme context toggle', async () => {
    const toggleTheme = vi.fn();
    render(<ThemeContext.Provider value={{ isDark: false, toggleTheme }}><App service={createService()} /></ThemeContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(toggleTheme).toHaveBeenCalledOnce();
    await screen.findByRole('heading', { name: 'No results available' });
  });

  it('prepares and reviews a first manual version without invoking an evaluation', async () => {
    const agent = { id: 'target-agent', name: 'Chosen agent', workspaceId, workspaceName: 'Fictional workspace A' };
    const saveSuite = vi.fn().mockImplementation(async (payload) => ({
      id: 'manual-v1', name: payload.name, version: 1, cases: payload.cases, hash: 'manual-hash', createdAt: bootstrap.checkedAt,
    }));
    const service = createService({ listAgents: vi.fn().mockResolvedValue({ agents: [agent], complete: true, checkedAt: bootstrap.checkedAt }), saveSuite });
    render(<App service={service} />);
    await open('Agents');
    fireEvent.click(await screen.findByRole('button', { name: /Chosen agent/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare tests' }));
    expect(screen.getByText(/Selected agent:/)).toHaveTextContent('Chosen agent · Fictional workspace A');
    expect(screen.getByText(/AI test generation is not configured/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /AI suggestions/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review selections' })).toBeDisabled();
    fillCase();
    fireEvent.click(screen.getByRole('button', { name: 'Save immutable version' }));
    await screen.findByText(/Saved “Fictional checks” version 1/);
    fireEvent.click(screen.getByRole('button', { name: 'Review selections' }));
    expect(window.location.hash).toBe('#review');
    const review = screen.getByRole('region', { name: 'Selection review' });
    expect(review).toHaveTextContent('Chosen agent · Fictional workspace A');
    expect(review).toHaveTextContent('Fictional checks · v1 · 1 test');
    expect(review).toHaveTextContent('manual-v1');
    expect(review).toHaveTextContent('manual-hash');
    expect(screen.getByRole('button', { name: 'Run evaluation' })).toBeDisabled();
    expect(review).toHaveTextContent('Evaluation execution and historical evidence reads are not available yet');
    fireEvent.click(screen.getByRole('button', { name: 'Edit or select tests' }));
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Unsaved revision?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review selections' }));
    expect(screen.getByRole('region', { name: 'Selection review' })).toHaveTextContent('Fictional checks · v1 · 1 test');
    expect(saveSuite).toHaveBeenCalledOnce();
    expect(service.listAgents).toHaveBeenCalledTimes(1);
    expect(Object.keys(service).sort()).toEqual(['approveRun', 'bootstrap', 'createRun', 'listAgents', 'runStatus', 'saveSuite']);
    expect(service.runStatus).not.toHaveBeenCalled();
    expect(service.createRun).not.toHaveBeenCalled();
    expect(service.approveRun).not.toHaveBeenCalled();
  });

  it('selects an existing version without editing or saving and preserves it across navigation', async () => {
    const suite: Suite = { id: 'saved-v2', name: 'Saved tests', version: 2, hash: 'saved-hash', createdAt: bootstrap.checkedAt,
      cases: [{ id: 'case-1', question: 'Saved question?', expectedAnswer: 'Saved answer.', category: '', critical: false }] };
    const agent = { id: 'target-agent', name: 'Chosen agent', workspaceId, workspaceName: 'Fictional workspace A' };
    const service = createService({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, suiteVersions: [suite] }),
      listAgents: vi.fn().mockResolvedValue({ agents: [agent], complete: true, checkedAt: bootstrap.checkedAt }) });
    render(<App service={service} />);
    await open('Agents');
    fireEvent.click(await screen.findByRole('button', { name: /Chosen agent/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare tests' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Saved tests version 2' }));
    expect(screen.getByRole('button', { name: 'Select Saved tests version 2' })).toHaveAttribute('aria-pressed', 'true');
    await open('Results');
    expect(await screen.findByRole('heading', { name: 'No results available' })).toBeVisible();
    screen.getAllByText(/Chosen agent/).forEach(element => expect(element).not.toBeVisible());
    await open('Tests');
    fireEvent.click(screen.getByRole('button', { name: 'Review selections' }));
    expect(screen.getByRole('region', { name: 'Selection review' })).toHaveTextContent('Saved tests · v2 · 1 test');
    expect(screen.getByRole('region', { name: 'Selection review' })).toHaveTextContent('saved-v2');
    expect(service.saveSuite).not.toHaveBeenCalled();
    expect(service.listAgents).toHaveBeenCalledTimes(1);
  });

  it('clears selected agent and suite when switching workspace but preserves the draft', async () => {
    const suite: Suite = { id: 'saved-v1', name: 'Saved tests', version: 1, hash: 'hash', createdAt: bootstrap.checkedAt,
      cases: [{ id: 'case-1', question: 'Saved?', expectedAnswer: 'Yes.', category: '', critical: false }] };
    const service = createService({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, suiteVersions: [suite] }),
      listAgents: vi.fn().mockImplementation(async (id: string) => ({
        agents: [{ id: id === workspaceId ? 'first' : 'second', name: id === workspaceId ? 'First agent' : 'Second agent', workspaceId: id, workspaceName: id === workspaceId ? 'Fictional workspace A' : 'Fictional workspace B' }],
        complete: true, checkedAt: bootstrap.checkedAt,
      })) });
    render(<App service={service} />);
    await open('Agents');
    fireEvent.click(await screen.findByRole('button', { name: /First agent/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare tests' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Saved tests version 1' }));
    fireEvent.click(screen.getByText('Create or edit a test suite', { selector: 'summary' }));
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Keep my draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change agent' }));
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: secondWorkspaceId } });
    expect(screen.getByText(/Workspace changed/)).toHaveTextContent('Select an agent and suite again');
    fireEvent.click(await screen.findByRole('button', { name: /Second agent/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare tests' }));
    expect(screen.getByLabelText('Question')).toHaveValue('Keep my draft');
    expect(screen.getByRole('button', { name: 'Review selections' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Select Saved tests version 1' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('guards unsaved drafts from replacement and browser unload', async () => {
    const suite: Suite = { id: 'saved-v1', name: 'Saved tests', version: 1, hash: 'hash', createdAt: bootstrap.checkedAt,
      cases: [{ id: 'case-1', question: 'Saved?', expectedAnswer: 'Yes.', category: '', critical: false }] };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<App service={createService({ bootstrap: vi.fn().mockResolvedValue({ ...bootstrap, suiteVersions: [suite] }) })} />);
    await open('Tests');
    fireEvent.click(screen.getByText('Create or edit a test suite', { selector: 'summary' }));
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Unsaved draft' } });
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Use as draft' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Question')).toHaveValue('Unsaved draft');
    confirm.mockRestore();
  });

  it('does not reselect an in-flight save after leaving and returning to a workspace', async () => {
    let resolveSave: ((suite: Suite) => void) | undefined;
    const saveSuite = vi.fn().mockImplementation(() => new Promise<Suite>((resolve) => { resolveSave = resolve; }));
    const service = createService({ saveSuite, listAgents: vi.fn().mockImplementation(async (id: string) => ({
      agents: [{ id: 'agent', name: 'Chosen agent', workspaceId: id, workspaceName: id === workspaceId ? 'Fictional workspace A' : 'Fictional workspace B' }],
      complete: true, checkedAt: bootstrap.checkedAt,
    })) });
    render(<App service={service} />);
    await open('Agents');
    fireEvent.click(await screen.findByRole('button', { name: /Chosen agent/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare tests' }));
    fillCase();
    fireEvent.click(screen.getByRole('button', { name: 'Save immutable version' }));
    await open('Agents');
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: secondWorkspaceId } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: workspaceId } });
    const payload = saveSuite.mock.calls[0][0];
    await act(async () => { resolveSave?.({ id: 'late-v1', name: payload.name, version: 1, cases: payload.cases, hash: 'hash', createdAt: bootstrap.checkedAt }); });
    fireEvent.click(await screen.findByRole('button', { name: /Chosen agent/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare tests' }));
    expect(screen.getByRole('button', { name: 'Review selections' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Select Fictional checks version 1' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('opens the review route safely without selections', async () => {
    window.history.replaceState(null, '', '#review');
    render(<App service={createService()} />);
    const review = await screen.findByRole('region', { name: 'Selection review' });
    expect(review).toHaveTextContent('Not selected');
    expect(screen.getByRole('button', { name: 'Run evaluation' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Tests' })).toHaveAttribute('aria-current', 'page');
  });
});
