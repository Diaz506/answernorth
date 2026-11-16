import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, BookOpen, ChevronRight,
  CircleAlert, Cloud, Database, FlaskConical, Layers,
  Moon, Plus, RefreshCw, Search, ShieldCheck, Sun, X,
} from 'lucide-react';
import { useTheme } from './hooks/theme.context';
import { AnswerNorthMark } from './AnswerNorthMark';
import {
  BackendRunError, JobThrottledError, UncertainRunWriteError, parseJobStatus, parseRun, proofbenchService, type Agent, type AgentInventory, type Bootstrap,
  type ProofbenchService, type RunRecord, type Suite, type SuiteCase,
} from './services/proofbench.service';
import './Proofbench.css';
import { Results } from './Results';
import { HowToUse } from './HowToUse';
import { clearPending, loadPending, persistPending, runMatchesPending, verifyPending, type PendingRun, type PendingState } from './services/pending-run';
import { loadPollTiming, markPollInFlight, markPollReconcile, pollDeadline, storePollDeadline, type PollTiming } from './services/job-poll';

const navigation = [
  { name: 'Results', icon: FlaskConical },
  { name: 'Agents', icon: Database },
  { name: 'Tests', icon: Layers },
] as const;
type Page = (typeof navigation)[number]['name'] | 'Review';
const suiteLimits = { cases: 30, question: 1000, answer: 1500, category: 80 };

function currentPage(): Page {
  const hash = window.location.hash.slice(1).toLowerCase();
  if (hash === 'suites') return 'Tests';
  if (hash === 'review') return 'Review';
  return navigation.find((item) => item.name.toLowerCase() === hash)?.name ?? 'Results';
}

function message(error: unknown): string {
  if (error instanceof Error && error.name === 'BackendConfigurationError') {
    return 'Backend configuration is missing or invalid. Ask your app administrator to configure ANSWERNORTH_TENANT_ID, ANSWERNORTH_WORKSPACE_ID, ANSWERNORTH_APP_ID, and ANSWERNORTH_OWNER_ID, then retry.';
  }
  if (error instanceof Error && error.name === 'BackendAccessError') {
    return 'Access is restricted to the configured app owner and tenant. Sign in with the authorized account or contact your app administrator.';
  }
  if (error instanceof Error && error.name === 'MissingRayfinConfigError') {
    return 'Backend configuration is missing. Ask your app administrator to configure the service URL and publishable key, then retry.';
  }
  if (error instanceof Error && error.message === 'Request timed out.') {
    return 'The cloud service took too long to respond. Check your connection and retry.';
  }
  return 'Could not connect to the AnswerNorth cloud service. Check configuration and workspace permissions, then retry.';
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Request timed out.')), 25000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' :
    `${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
}

function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return <div className={`pb-notice ${error ? 'pb-notice-error' : ''}`} role={error ? 'alert' : 'status'}>
    <CircleAlert aria-hidden="true" size={18} /><div>{children}</div>
  </div>;
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="pb-empty"><FlaskConical aria-hidden="true" size={32} />
    <h3>{title}</h3><p>{children}</p></div>;
}

export default function App({ service = proofbenchService }: { service?: ProofbenchService }) {
  const { isDark, toggleTheme } = useTheme();
  const [page, setPageState] = useState<Page>(currentPage);
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [workspaceId, setWorkspaceIdState] = useState('');
  const [inventory, setInventory] = useState<AgentInventory | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentError, setAgentError] = useState('');
  const [agentAttempt, setAgentAttempt] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [selectedSuite, setSelectedSuite] = useState<Suite | null>(null);
  const [workspaceChanged, setWorkspaceChanged] = useState(false);
  const workspaceRef = useRef('');
  const workspaceRevisionRef = useRef(0);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [pendingState, setPendingState] = useState<PendingState>({ kind: 'unavailable' });

  const resetAgentInventory = useCallback(() => {
    setAgentLoading(true);
    setAgentError('');
    setInventory(null);
  }, []);

  const setWorkspaceId = useCallback((id: string) => {
    if (workspaceRef.current === id) return;
    const hadWorkspace = Boolean(workspaceRef.current);
    workspaceRef.current = id;
    workspaceRevisionRef.current += 1;
    setWorkspaceRevision(workspaceRevisionRef.current);
    setWorkspaceIdState(id);
    setSelectedAgent(null);
    setSelectedSuite(null);
    setWorkspaceChanged(hadWorkspace);
    if (id) {
      resetAgentInventory();
      setAgentAttempt((value) => value + 1);
    }
  }, [resetAgentInventory]);

  function setPage(next: Page) {
    setPageState(next);
    if (window.location.hash !== `#${next.toLowerCase()}`) {
      window.location.hash = next.toLowerCase();
    }
  }

  useEffect(() => {
    const changed = () => setPageState(currentPage());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);

  useEffect(() => {
    let active = true;
    void bounded(service.bootstrap()).then((result) => {
      if (!active) return;
      setData(result);
      setPendingState(loadPending(result.runs));
      setWorkspaceId(result.workspaces[0]?.id ?? '');
    }).catch((failure: unknown) => { if (active) setError(message(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [service, attempt, setWorkspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    void bounded(service.listAgents(workspaceId)).then((result) => {
      if (active) setInventory(result);
    }).catch((failure: unknown) => { if (active) setAgentError(message(failure)); })
      .finally(() => { if (active) setAgentLoading(false); });
    return () => { active = false; };
  }, [service, workspaceId, agentAttempt]);

  function saved(suite: Suite, savedForRevision: number) {
    setData((current) => current && {
      ...current,
      suiteVersions: [...current.suiteVersions.filter((item) => item.id !== suite.id), suite],
    });
    if (workspaceRevisionRef.current === savedForRevision) setSelectedSuite(suite);
  }

  function savedRun(run: RunRecord) {
    setData((current) => current && {
      ...current, runs: [run, ...current.runs.filter((item) => item.id !== run.id)],
    });
  }

  return <div className="pb-app">
    <a className="pb-skip" href="#pb-main" onClick={(event) => {
      event.preventDefault(); document.getElementById('pb-main')?.focus();
    }}>Skip to content</a>
    <aside className="pb-sidebar">
      <a className="pb-brand" href="#results" onClick={(event) => { event.preventDefault(); setPage('Results'); }} aria-label="AnswerNorth results">
        <span className="pb-mark"><AnswerNorthMark className="answer-north-mark" /></span>
        <span>AnswerNorth<span className="pb-brand-caption">DATA AGENT EVALUATION</span></span>
      </a>
      <div className="pb-side-label">WORKBENCH</div>
      <nav aria-label="Main navigation">
        {navigation.map(({ name, icon: Icon }, index) => <a
          href={`#${name.toLowerCase()}`} key={name} aria-label={name}
          aria-current={page === name || (page === 'Review' && name === 'Tests') ? 'page' : undefined}
          className={`pb-nav-link ${page === name || (page === 'Review' && name === 'Tests') ? 'is-active' : ''}`}
          onClick={(event) => { event.preventDefault(); setPage(name); }}>
          <Icon aria-hidden="true" size={18} /><span>{name}</span><span className="pb-nav-index">0{index + 1}</span>
        </a>)}
      </nav>
      <div className="pb-side-footer">
        <div className="pb-cloud-label"><Cloud size={16} aria-hidden="true" /> CLOUD ONLY</div>
        <p>Evidence, not assumptions.</p>
        <span className="pb-small">Fabric-native evaluation workbench</span>
      </div>
    </aside>
    <div className="pb-workspace">
      <header className="pb-topbar">
        <div className="pb-breadcrumb">Workspace <ChevronRight size={14} aria-hidden="true" />
          <strong>{data?.workspace.name ?? (error ? 'Unavailable' : 'Loading…')}</strong></div>
        <div className="pb-top-actions"><span className="pb-pill"><ShieldCheck size={14} aria-hidden="true" /> Protected session</span>
          <button className="pb-icon-button" onClick={toggleTheme} aria-label={`Switch to ${isDark ? 'light' : 'dark'} theme`}>
            {isDark ? <Sun size={18} /> : <Moon size={18} />}
          </button></div>
      </header>
      <main id="pb-main" className="pb-main" tabIndex={-1}>
        <div className="pb-page-heading"><div><div className="pb-eyebrow">ANSWERNORTH / {page.toUpperCase()}</div>
          <h1>{page === 'Results' ? 'Evidence, clearly.' : page === 'Agents' ? 'Choose your source.' : page === 'Review' ? 'Review your selections.' : 'Prepare your tests.'}</h1>
          <p>{page === 'Results' ? 'Results and historical evidence are not available yet.' :
            page === 'Agents' ? 'Find an accessible data agent in your source workspace.' : page === 'Review' ?
              'Confirm your selections before a future run. No evaluation is started here.' :
              'Curate questions and expected answers. Save each revision as an immutable version.'}</p></div>
        </div>
        <p className="pb-notice">Access is restricted to the configured application owner and tenant. Workspace discovery uses the app owner’s Fabric permissions, not viewer permissions.</p>
        <HowToUse />
        {loading ? <div className="pb-loading" role="status"><div className="pb-loading-line" />Connecting to your cloud workspace…</div> :
          error ? <div className="pb-panel"><Notice error>{error}</Notice><button className="pb-button" onClick={() => { setLoading(true); setError(''); setAttempt((value) => value + 1); }}><RefreshCw size={16} /> Retry connection</button></div> :
            data && <>
              {page === 'Results' && <Results reviewTests={() => setPage('Tests')} chooseAgent={() => setPage('Agents')} />}
              {page === 'Agents' && <Agents data={data} workspaceId={workspaceId} setWorkspaceId={setWorkspaceId}
                inventory={inventory} loading={agentLoading} error={agentError} retry={() => { resetAgentInventory(); setAgentAttempt((value) => value + 1); }}
                selected={selectedAgent} select={setSelectedAgent} go={setPage} workspaceChanged={workspaceChanged} />}
              <div hidden={page !== 'Review'}>
                <Review agent={selectedAgent} suite={selectedSuite} go={setPage} data={data} service={service}
                  workspaceId={workspaceId} setWorkspaceId={setWorkspaceId} inventory={inventory} inventoryLoading={agentLoading}
                  selectAgent={setSelectedAgent} selectSuite={setSelectedSuite} savedRun={savedRun} visible={page === 'Review'}
                  pendingState={pendingState} setPendingState={setPendingState} />
              </div>
              <div hidden={page !== 'Tests'}>
                <section className="pb-panel pb-flow-context" aria-label="Run preparation">
                  <div className="pb-section-title"><h2>Prepare tests</h2><span className="pb-tag">STEP 2 OF 3</span></div>
                  {selectedAgent ? <p>Selected agent: <strong>{selectedAgent.name}</strong> · {selectedAgent.workspaceName}</p> :
                    <p>Choose an agent to prepare a run. You can still create or review tests here.</p>}
                  <div className="pb-flow-actions"><button className="pb-button" onClick={() => setPage('Agents')}>{selectedAgent ? 'Change agent' : 'Choose agent'}</button>
                    <button className="pb-button pb-primary" disabled={!selectedAgent || !selectedSuite} onClick={() => setPage('Review')}>Review selections <ArrowRight size={16} aria-hidden="true" /></button>
                    <button className="pb-button" onClick={() => setPage('Review')}>Review saved run drafts</button></div>
                  <p className="pb-small pb-muted">{selectedSuite ? `Selected: ${selectedSuite.name} · v${selectedSuite.version} · ${selectedSuite.cases.length} ${selectedSuite.cases.length === 1 ? 'test' : 'tests'}` : 'Select or save an immutable suite version to continue.'}</p>
                  <p className="pb-small pb-muted">AI test generation is not configured. Manual tests and saved suites remain available.</p>
                </section>
                {!data.suitesComplete && <Notice>The cloud version library is partial. Additional suite versions may exist; do not infer totals from this list.</Notice>}
                <SuiteEditor suites={data.suiteVersions} service={service} workspaceRevision={workspaceRevision} onSaved={saved} selectedSuite={selectedSuite} selectSuite={setSelectedSuite} />
              </div>
            </>}
        <footer className="pb-content-footer"><span>ANSWERNORTH <span aria-hidden="true">/</span> PRECISION OVER PROMISES</span>
          <span>{data ? `Cloud inventory checked ${formatTime(data.checkedAt)}` : 'Authenticated cloud workspace'}</span></footer>
      </main>
    </div>
  </div>;
}

function Agents({ data, workspaceId, setWorkspaceId, inventory, loading, error, retry, selected, select, go, workspaceChanged }: {
  data: Bootstrap; workspaceId: string; setWorkspaceId: (id: string) => void;
  inventory: AgentInventory | null; loading: boolean; error: string; retry: () => void;
  selected: Agent | null; select: (agent: Agent) => void; go: (page: Page) => void;
  workspaceChanged: boolean;
}) {
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState('');
  const [search, setSearch] = useState('');
  const agents = inventory?.agents.filter((agent) => agent.name.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <div className="pb-agents-layout"><section className="pb-panel">
    <div className="pb-section-title"><h2>Source workspace</h2><span className="pb-tag">AUTHORIZED DISCOVERY</span></div>
    <label className="pb-field">Workspace<select value={data.workspaces.some((item) => item.id === workspaceId) ? workspaceId : ''} onChange={(event) => { if (event.target.value) setWorkspaceId(event.target.value); }}>
      <option value="">Choose a workspace</option>{data.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    <p className="pb-small pb-muted">Changing workspace clears the selected agent and suite. Your unsaved test draft stays open in this session.</p>
    {workspaceChanged && <Notice>Workspace changed. Select an agent and suite again; your test draft is unchanged.</Notice>}
    {!data.workspacesComplete && <Notice>Workspace discovery is partial. Enter an exact workspace ID if an accessible source is missing.</Notice>}
    <details><summary>Workspace and access details</summary><form className="pb-manual-workspace" onSubmit={(event) => {
      event.preventDefault();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(manual.trim())) {
        setManualError('Enter a valid Fabric workspace UUID.'); return;
      }
      setManualError(''); setWorkspaceId(manual.trim());
    }}><label className="pb-field">Or enter a workspace ID<input value={manual} onChange={(event) => setManual(event.target.value)} aria-invalid={Boolean(manualError)} aria-describedby={manualError ? 'workspace-error' : 'workspace-help'} /></label>
      <p className="pb-small pb-muted" id="workspace-help">Discovery uses the app owner’s Fabric permissions, not delegated viewer permissions. Entering an ID never grants access.</p>
      {manualError && <p className="pb-field-error" id="workspace-error" role="alert">{manualError}</p>}
      <button className="pb-button" type="submit">Discover workspace <ArrowRight size={16} /></button>
    </form>{workspaceId && <code className="pb-id">{workspaceId}</code>}</details>
    <div className="pb-divider" />
    <div className="pb-toolbar"><h2>Data agents</h2><button className="pb-icon-button" aria-label="Refresh agents" onClick={retry} disabled={!workspaceId || loading}><RefreshCw size={17} /></button></div>
    <label className="pb-search"><Search size={16} aria-hidden="true" /><input aria-label="Filter data agents" placeholder="Filter data agents…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    {loading ? <p className="pb-loading" role="status">Discovering authorized data agents…</p> :
      error ? <><Notice error>{error}</Notice><button className="pb-button" onClick={retry}>Retry discovery</button></> :
        !workspaceId ? <Empty title="Choose a source workspace">Select a workspace or enter its ID to discover agents.</Empty> :
          agents.length === 0 ? <Empty title={search ? 'No matching agents' : 'No data agents found'}>{search ? 'Try another filter.' : 'No accessible data agents were returned for this workspace. Try another workspace or verify your Fabric access.'}</Empty> :
            <div className="pb-agent-list">{agents.map((agent) => <button key={agent.id} className={`pb-agent-row ${selected?.id === agent.id ? 'is-selected' : ''}`} onClick={() => select(agent)}>
              <span className="pb-agent-icon"><Database size={20} aria-hidden="true" /></span><span><strong>{agent.name}</strong><span className="pb-small pb-muted">{agent.workspaceName}</span></span><ChevronRight size={17} aria-hidden="true" />
            </button>)}</div>}
    {inventory && <p className="pb-small pb-muted">{inventory.complete ? 'Discovery complete' : 'Partial inventory — more items may be available'}. Checked {formatTime(inventory.checkedAt)}.</p>}
  </section><section className="pb-panel pb-agent-detail">
    <div className="pb-eyebrow">SOURCE AGENT</div>{selected ? <><div className="pb-detail-icon"><Database size={32} aria-hidden="true" /></div><h2>{selected.name}</h2>
      <p className="pb-muted">{selected.workspaceName}</p>
      <details><summary>Agent details</summary><dl className="pb-definition"><dt>Agent ID</dt><dd><code>{selected.id}</code></dd><dt>Workspace ID</dt><dd><code>{selected.workspaceId}</code></dd></dl>
        <p>Discovery confirms access, not readiness for a new evaluation.</p></details>
      <button className="pb-button pb-primary" onClick={() => go('Tests')}>Prepare tests <ArrowRight size={16} /></button></> :
      <Empty title="Choose an agent">Select a discovered agent to see its source and review your tests.</Empty>}
  </section></div>;
}

function matchesRun(run: RunRecord, agent: Agent | null, suite: Suite | null, stage: 'production' | 'sandbox'): boolean {
  return Boolean(agent && suite && run.target.id === agent.id && run.target.name === agent.name &&
    run.target.workspaceId === agent.workspaceId && run.target.workspaceName === agent.workspaceName &&
    run.target.stage === stage && run.suite.id === suite.id && run.suite.name === suite.name &&
    run.suite.version === suite.version && run.suite.hash === suite.hash && run.suite.caseCount === suite.cases.length);
}

function JobStatus({ run, service }: { run: RunRecord; service: ProofbenchService }) {
  const [observation, setObservation] = useState<ReturnType<typeof parseJobStatus>['job']>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const initialDeadline = run.job ? pollDeadline(run.job.acceptedAt, run.job.firstPollAfterSeconds) : null;
  const [timing, setTiming] = useState<PollTiming>(() => initialDeadline === null ?
    { kind: 'blocked' } : loadPollTiming(run.id, initialDeadline));
  const [clock, setClock] = useState(Date.now);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (timing.kind !== 'ready' || timing.notBefore <= clock) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.min(timing.notBefore - clock, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [timing, clock]);

  async function refresh() {
    if (busyRef.current || !run.job || initialDeadline === null || timing.kind !== 'ready') return;
    const savedTiming = loadPollTiming(run.id, initialDeadline);
    if (savedTiming.kind !== 'ready') { setTiming(savedTiming); return; }
    const notBefore = Math.max(timing.notBefore, savedTiming.notBefore);
    if (Date.now() < notBefore) {
      setClock(Date.now()); setTiming({ kind: 'ready', notBefore }); return;
    }
    if (!markPollInFlight(run.id)) { setTiming({ kind: 'blocked' }); return; }
    busyRef.current = true; setBusy(true); setError('');
    try {
      const result = parseJobStatus(await bounded(service.runStatus(run.id)), run.id);
      const job = result.run.job;
      if (result.run.requestId !== run.requestId || result.run.approvalDigest !== run.approvalDigest || !job ||
          job.workspaceId !== run.job.workspaceId || job.notebookId !== run.job.notebookId || job.jobId !== run.job.jobId ||
          job.acceptedAt !== run.job.acceptedAt || job.firstPollAfterSeconds !== run.job.firstPollAfterSeconds) throw new Error('Invalid job receipt');
      const deadline = result.job?.nextPollAfterSeconds != null ?
        pollDeadline(result.job.checkedAt, result.job.nextPollAfterSeconds) : initialDeadline;
      const stored = deadline !== null && storePollDeadline(run.id, Math.max(initialDeadline, deadline));
      if (mounted.current) {
        setObservation(result.job); setChecked(true); setClock(Date.now());
        setTiming(stored && deadline !== null ? { kind: 'ready', notBefore: Math.max(initialDeadline, deadline) } : { kind: 'blocked' });
      }
    } catch (failure) {
      if (failure instanceof JobThrottledError) {
        const delay = failure.retryAfterSeconds;
        if (delay === null) {
          const stored = markPollReconcile(run.id);
          if (mounted.current) setTiming({ kind: stored ? 'reconcile' : 'blocked' });
        } else {
          const deadline = Math.max(notBefore, Date.now() + delay * 1000);
          const stored = storePollDeadline(run.id, deadline);
          if (mounted.current) {
            setClock(Date.now());
            setTiming(stored ? { kind: 'ready', notBefore: deadline } : { kind: 'blocked' });
            setError('Job status was throttled. Only refresh manually after the provider delay; no automatic retry will occur.');
          }
        }
        return;
      }
      const restored = storePollDeadline(run.id, notBefore);
      if (mounted.current) {
        if (!restored) setTiming({ kind: 'blocked' });
        setError(failure instanceof Error && failure.name === 'BackendConfigurationError' ?
          'Job status configuration is invalid. Ask your administrator to check the configured job workspace and notebook (ANSWERNORTH_JOB_WORKSPACE_ID and ANSWERNORTH_JOB_NOTEBOOK_ID). No automatic retry will occur.' :
          'Job status could not be refreshed. No automatic retry will occur.');
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const labels = {
    job_not_started: 'Job not started',
    job_running: 'Job running',
    job_completed_unverified: 'Job completed — not verified results',
    job_failed: 'Job failed',
    job_cancelled: 'Job cancelled',
    job_deduped: 'Job deduped',
  };
  return <section aria-label="Notebook job status">
    <h3>Notebook job status</h3>
    <p>Job accepted {formatTime(run.job!.acceptedAt)}. This receipt is not evidence of results.</p>
    <p>{observation ? <><strong>{labels[observation.state]}</strong> · checked {formatTime(observation.checkedAt)}.
      {observation.nextPollAfterSeconds !== null && ` Provider delay: ${observation.nextPollAfterSeconds} seconds.`}</> :
      checked ? 'No job observation was returned.' : `Status has not been refreshed. Initial provider delay: ${run.job!.firstPollAfterSeconds} seconds.`}</p>
    <p className="pb-small pb-muted">Refresh is explicit only; status is never polled automatically. No results or scores are verified here.</p>
    {timing.kind === 'reconcile' ? <Notice error>Job status was throttled without a valid retry delay. Refresh is disabled; reconcile the job status and contact your administrator.</Notice> :
      timing.kind === 'blocked' ? <Notice error>Refresh timing cannot be safely restored or saved in session storage, or a request was interrupted. Refresh is disabled; reconcile the job status and contact your administrator.</Notice> :
      timing.notBefore > clock && <p className="pb-small pb-muted" role="status">Refresh available after {formatTime(new Date(timing.notBefore).toISOString())}.</p>}
    {error && <Notice error>{error}</Notice>}
    <button className="pb-button" disabled={busy || timing.kind !== 'ready' || timing.notBefore > clock}
      onClick={() => void refresh()}>{busy ? 'Refreshing job status…' : 'Refresh job status'}</button>
  </section>;
}

function hasValidatedJob(run: RunRecord): boolean {
  try { const parsed = parseRun({ run }); return parsed.status === 'job_accepted' && Boolean(parsed.job); }
  catch { return false; }
}

function Review({ agent, suite, go, data, service, workspaceId, setWorkspaceId, inventory, inventoryLoading, selectAgent, selectSuite, savedRun, visible, pendingState, setPendingState }: {
  agent: Agent | null; suite: Suite | null; go: (page: Page) => void; data: Bootstrap; service: ProofbenchService;
  workspaceId: string; setWorkspaceId: (id: string) => void; inventory: AgentInventory | null; inventoryLoading: boolean;
  selectAgent: (agent: Agent) => void; selectSuite: (suite: Suite) => void; savedRun: (run: RunRecord) => void;
  visible: boolean;
  pendingState: PendingState; setPendingState: (state: PendingState) => void;
}) {
  const [stage, setStage] = useState<'production' | 'sandbox'>('production');
  const [activeId, setActiveId] = useState('');
  const [confirmation, setConfirmation] = useState<object | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [createLocked, setCreateLocked] = useState(false);
  const [approveLocked, setApproveLocked] = useState(false);
  const [runError, setRunError] = useState('');
  const activeRun = data.runs.find((run) => run.id === activeId);
  const pending = pendingState.kind === 'pending' ? pendingState.pending : null;
  const pendingAgent = pending && !inventoryLoading && pending.selection.workspaceId === workspaceId ?
    inventory?.agents.find((item) => item.workspaceId === workspaceId && item.id === pending.selection.agentId) : undefined;
  const pendingSuite = pending && data.suiteVersions.find((item) => item.id === pending.selection.suiteId);
  const pendingMatches = Boolean(pending && agent && suite && pendingAgent && pendingSuite &&
    pending.selection.workspaceId === workspaceId && agent.id === pendingAgent.id &&
    agent.workspaceId === workspaceId && agent.name === pendingAgent.name && agent.workspaceName === pendingAgent.workspaceName &&
    suite.id === pendingSuite.id && suite.hash === pendingSuite.hash && stage === pending.selection.stage);
  const storageBlocked = pendingState.kind === 'unavailable' || pendingState.kind === 'invalid' || pendingState.kind === 'conflict';
  const matches = activeRun ? matchesRun(activeRun, agent, suite, stage) && agent?.workspaceId === workspaceId : false;
  // A new token makes prior confirmation invalid even if the user later reselects the same values.
  const confirmationKey = useMemo(
    () => ({ agent, suite, stage, activeId, workspaceId, activeRun }),
    [agent, suite, stage, activeId, workspaceId, activeRun],
  );
  const confirmed = confirmation === confirmationKey;
  function resume(run: RunRecord) {
    setActiveId(run.id); setConfirmation(null);
    if (run.target.workspaceId !== workspaceId) {
      setWorkspaceId(run.target.workspaceId);
      setRunError('Workspace changed. Once agent discovery finishes, select Resume and review again.');
      return;
    }
    if (inventoryLoading || !inventory) {
      setRunError('Agent discovery is not available yet. Wait for discovery or retry it in Agents, then resume this draft.');
      return;
    }
    const foundAgent = inventory.agents.find((item) => item.id === run.target.id &&
      item.name === run.target.name && item.workspaceId === run.target.workspaceId &&
      item.workspaceName === run.target.workspaceName);
    const foundSuite = data.suiteVersions.find((item) => matchesRun(run, foundAgent ?? null, item, run.target.stage));
    if (!foundAgent || !foundSuite) {
      setRunError('The frozen agent or suite is unavailable or does not match the current inventory. Approval is disabled; refresh or select the exact original items.');
      return;
    }
    selectAgent(foundAgent); selectSuite(foundSuite); setStage(run.target.stage);
    setRunError('');
  }

  async function create(retry: boolean) {
    if (busyRef.current || createLocked || storageBlocked || !agent || !suite || agent.workspaceId !== workspaceId ||
      (retry ? !pending || !pendingMatches : Boolean(pending))) return;
    busyRef.current = true; setBusy(true); setRunError('');
    let request: PendingRun;
    try {
      request = retry && pending ? pending : { requestId: crypto.randomUUID().toLowerCase(), selection: { workspaceId, agentId: agent.id, suiteId: suite.id, stage } };
      if (retry ? !verifyPending(request) : !persistPending(request)) {
        setPendingState({ kind: 'unavailable' });
        setRunError('Browser session storage is unavailable or changed. No draft request was sent. Restore storage and reload before proceeding.');
        return;
      }
      setPendingState({ kind: 'pending', pending: request });
      const result = await bounded(service.createRun(request.selection, request.requestId));
      if (!runMatchesPending(result, request) || !matchesRun(result, agent, suite, stage)) throw new Error('Invalid run acknowledgement');
      savedRun(result); setActiveId(result.id); setConfirmation(null);
      if (clearPending(request)) setPendingState(retry ? { kind: 'reconciled', runId: result.id } : { kind: 'empty' });
      else {
        setPendingState({ kind: 'unavailable' });
        setRunError('The draft was returned, but browser session storage could not be cleared. Reload and verify the saved draft before proceeding.');
      }
    } catch (failure) {
      setCreateLocked(true);
      const detail = failure instanceof BackendRunError || failure instanceof UncertainRunWriteError ? `${failure.message} ` :
        failure instanceof Error && (failure.name === 'BackendConfigurationError' || failure.name === 'BackendAccessError') ? `${message(failure)} ` : '';
      setRunError(`${detail}The draft save could not be confirmed. Reload this page to reconcile the saved request before an explicit retry. No automatic retry will occur.`);
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function approve() {
    if (busyRef.current || approveLocked || pending || storageBlocked || !activeRun || !matches || !confirmed || activeRun.status !== 'awaiting_approval') return;
    busyRef.current = true; setBusy(true); setRunError('');
    try {
      const result = await bounded(service.approveRun(activeRun.id, activeRun.approvalDigest));
      if (result.id !== activeRun.id || result.requestId !== activeRun.requestId || result.approvalDigest !== activeRun.approvalDigest ||
          !matchesRun(result, agent, suite, stage) || result.status !== 'approved') throw new Error('Invalid approval acknowledgement');
      savedRun(result); setConfirmation(null);
    } catch (failure) {
      setApproveLocked(true); setConfirmation(null);
      const detail = failure instanceof BackendRunError || failure instanceof UncertainRunWriteError ? `${failure.message} ` :
        failure instanceof Error && (failure.name === 'BackendConfigurationError' || failure.name === 'BackendAccessError') ? `${message(failure)} ` : '';
      setRunError(`${detail}The approval could not be confirmed. Reload this page and check the draft status before trying again. Do not retry until reloaded.`);
    } finally { busyRef.current = false; setBusy(false); }
  }

  if (!visible) return null;
  return <section className="pb-panel pb-flow-context" aria-label="Selection review">
    <div className="pb-section-title"><h2>Selection review</h2><span className="pb-tag">STEP 3 OF 3</span></div>
    <dl className="pb-definition">
      <dt>Agent</dt><dd>{agent ? `${agent.name} · ${agent.workspaceName}` : 'Not selected'}</dd>
      <dt>Saved test version</dt><dd>{suite ? `${suite.name} · v${suite.version} · ${suite.cases.length} ${suite.cases.length === 1 ? 'test' : 'tests'}` : 'Not selected'}</dd>
    </dl>
    <details><summary>Selection details</summary><dl className="pb-definition">
      <dt>Agent ID</dt><dd><code>{agent?.id ?? 'Not selected'}</code></dd>
      <dt>Source workspace ID</dt><dd><code>{agent?.workspaceId ?? 'Not selected'}</code></dd>
      <dt>Suite ID</dt><dd><code>{suite?.id ?? 'Not selected'}</code></dd>
      <dt>Content hash</dt><dd><code>{suite?.hash ?? 'Not selected'}</code></dd>
    </dl></details>
    <label className="pb-field">Target stage<select value={stage} disabled={busy} onChange={(event) => {
      setStage(event.target.value === 'sandbox' ? 'sandbox' : 'production'); setConfirmation(null);
    }}><option value="production">Production</option><option value="sandbox">Sandbox</option></select></label>
    <p>Publication is not verified for either stage. Approval is for the plan only; it does not submit or execute an evaluation. Execution remains disabled.</p>
    {suite && <details open><summary>Inspect selected suite questions and expected answers</summary>
      <ol>{suite.cases.map((item) => <li key={item.id}><h3>{item.question}</h3>
        <p><strong>Expected answer:</strong> {item.expectedAnswer}</p>
        <p className="pb-small pb-muted">{item.category || 'Uncategorized'}{item.critical ? ' · Critical' : ''}</p></li>)}</ol>
    </details>}
    {runError && <Notice error>{runError}</Notice>}
    {(createLocked || approveLocked) && <Notice>
      {createLocked && 'Draft creation is disabled until reload. '}{approveLocked && 'Approval is disabled until reload. '}
      Reload and check saved draft status before retrying.
    </Notice>}
    {storageBlocked && <Notice error>Draft recovery is blocked because browser session storage is unavailable, invalid, or conflicts with a saved record. Restore access and reload; contact your administrator if the problem persists. No new draft will be created.</Notice>}
    {pendingState.kind === 'reconciled' && <Notice>The pending request was matched to a saved draft. Review it below; it was not automatically approved.</Notice>}
    {pending && <Notice>The previous draft request remains uncertain, even if it is absent from the returned history. No automatic retry was made. Restore the original workspace, agent, suite, and {pending.selection.stage} stage to enable an explicit retry with the same request ID. If the selection cannot be restored, contact your administrator.</Notice>}
    {pending && pending.selection.workspaceId === workspaceId && !inventoryLoading && (!pendingAgent || !pendingSuite) &&
      <Notice error>The original selection cannot be restored from the current inventory. Retry discovery or contact your administrator; the pending request has been retained.</Notice>}
    {pending && <div className="pb-flow-actions"><button className="pb-button" disabled={busy || !pendingAgent || !pendingSuite} onClick={() => {
      if (pendingAgent && pendingSuite) { selectAgent(pendingAgent); selectSuite(pendingSuite); setStage(pending.selection.stage); setConfirmation(null); }
    }}>Restore pending selection</button>
      <button className="pb-button pb-primary" disabled={busy || createLocked || !pendingMatches} onClick={() => void create(true)}>Retry pending draft request</button></div>}
    <button className="pb-button pb-primary" disabled={busy || createLocked || storageBlocked || Boolean(pending) || !agent || !suite || agent.workspaceId !== workspaceId}
      onClick={() => void create(false)}>{busy ? 'Saving or approving…' : 'Create draft record'}</button>
    <div className="pb-divider" />
    <div className="pb-section-title"><h2>Saved run drafts</h2><span className="pb-tag">OWNER SCOPED</span></div>
    {!data.runsComplete && <Notice>The run draft list is partial. Additional records may exist; a draft missing from this list may still have been saved.</Notice>}
    {data.runs.length === 0 ? <p>{pending ? 'No run drafts were returned; the pending request may still have been saved.' : data.runsComplete ? 'No saved run drafts yet.' : 'No run drafts were returned in this partial list.'}</p> : <div className="pb-version-list">{data.runs.map((run) =>
      <div className="pb-version-row" key={run.id}><div><strong>{run.target.name} · {run.suite.name} v{run.suite.version}</strong>
        {pendingState.kind === 'reconciled' && pendingState.runId === run.id && <span className="pb-tag">RECOVERED PENDING REQUEST</span>}
        <span className="pb-small pb-muted">{run.target.workspaceName} · {run.target.stage} · {run.status.replaceAll('_', ' ')} · {formatTime(run.createdAt)}</span></div>
        <button className="pb-button" disabled={busy} aria-label={pendingState.kind === 'reconciled' && pendingState.runId === run.id ? 'Resume and review recovered draft' : undefined}
          onClick={() => resume(run)}>Resume and review</button></div>)}</div>}
    {activeRun && <div className="pb-run-review">
      <h3>Draft review: {activeRun.target.name} · {activeRun.suite.name} v{activeRun.suite.version}</h3>
      <p>Status: <strong>{activeRun.status.replaceAll('_', ' ')}</strong> · {activeRun.target.stage}</p>
      <details><summary>Frozen draft details</summary><dl className="pb-definition">
        <dt>Agent ID</dt><dd><code>{activeRun.target.id}</code></dd><dt>Workspace ID</dt><dd><code>{activeRun.target.workspaceId}</code></dd>
        <dt>Suite ID</dt><dd><code>{activeRun.suite.id}</code></dd><dt>Suite hash</dt><dd><code>{activeRun.suite.hash}</code></dd>
        <dt>Approval digest</dt><dd><code>{activeRun.approvalDigest}</code></dd></dl></details>
      {!matches && <Notice>Current selections do not match this frozen draft. Resume it with the original available agent and suite before approval.</Notice>}
      {activeRun.status === 'submission_uncertain' && <Notice>An internal claim is unresolved. There is no public submission action; execution remains disabled.</Notice>}
      {hasValidatedJob(activeRun) && <JobStatus key={`${activeRun.id}:${JSON.stringify(activeRun.job)}`} run={activeRun} service={service} />}
      <label className="pb-checkbox"><input type="checkbox" checked={confirmed} disabled={!matches || busy || Boolean(pending) || storageBlocked || activeRun.status !== 'awaiting_approval' || approveLocked}
        onChange={(event) => setConfirmation(event.target.checked ? confirmationKey : null)} /><span>I reviewed the exact questions and expected answers and approve this plan only.</span></label>
      <button className="pb-button pb-primary" disabled={!matches || !confirmed || busy || Boolean(pending) || storageBlocked || approveLocked || activeRun.status !== 'awaiting_approval'}
        onClick={() => void approve()}>Approve draft plan</button>
    </div>}
    <p className="pb-notice">Evaluation execution and historical evidence reads are not available yet. No agent will be called and no evaluation will be submitted from this screen.</p>
    <div className="pb-flow-actions"><button className="pb-button" onClick={() => go('Agents')}>Change agent</button>
      <button className="pb-button" onClick={() => go('Tests')}>Edit or select tests</button>
      <button className="pb-button pb-primary" disabled aria-describedby="run-gate">Run evaluation</button></div>
    <p id="run-gate" className="pb-small pb-muted">Evaluation execution is not available yet.</p>
    <p className="pb-small pb-muted">No verified results are shown for these selections.</p>
  </section>;
}

function newCase(): SuiteCase {
  return { id: crypto.randomUUID(), question: '', expectedAnswer: '', category: '', critical: false };
}

function SuiteEditor({ suites, service, workspaceRevision, onSaved, selectedSuite, selectSuite }: {
  suites: Suite[]; service: ProofbenchService; workspaceRevision: number; onSaved: (suite: Suite, workspaceRevision: number) => void;
  selectedSuite: Suite | null; selectSuite: (suite: Suite) => void;
}) {
  const [editorOpen, setEditorOpen] = useState(suites.length === 0);
  const [name, setName] = useState('');
  const [cases, setCases] = useState<SuiteCase[]>(() => [newCase()]);
  const [activeId, setActiveId] = useState(cases[0]?.id ?? '');
  const [validation, setValidation] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [ack, setAck] = useState<Suite | null>(null);
  const [hasDraftChanges, setHasDraftChanges] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const selected = cases.find((item) => item.id === activeId) ?? cases[0];
  const invalidCases = cases.filter((item) => !item.question.trim() || !item.expectedAnswer.trim() ||
    item.question.length > suiteLimits.question || item.expectedAnswer.length > suiteLimits.answer ||
    item.category.length > suiteLimits.category);
  useEffect(() => {
    if (!hasDraftChanges) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [hasDraftChanges]);
  const dirty = () => { setAck(null); setError(''); setHasDraftChanges(true); };
  function update(patch: Partial<SuiteCase>) {
    dirty(); setCases((items) => items.map((item) => item.id === selected?.id ? { ...item, ...patch } : item));
  }
  async function save() {
    setValidation(true); setAck(null); setError('');
    if (!name.trim() || invalidCases.length > 0 || !cases.length || cases.length > suiteLimits.cases) {
      if (invalidCases[0]) setActiveId(invalidCases[0].id);
      return;
    }
    setSaving(true);
    try {
      const result = await bounded(service.saveSuite({ name: name.trim(), cases: cases.map((item) => ({
        ...item, question: item.question.trim(), expectedAnswer: item.expectedAnswer.trim(), category: item.category.trim(),
      })) }));
      setAck(result); setHasDraftChanges(false); onSaved(result, workspaceRevision);
    } catch (failure) { setError(message(failure)); } finally { setSaving(false); }
  }
  return <>
    <section className="pb-suite">
    <div className="pb-saved-suites"><div className="pb-section-title"><h2>Saved test suites</h2><span className="pb-tag">{suites.length} SAVED</span></div>
      {suites.length === 0 ? <p className="pb-muted">No saved versions yet. Create a test suite below.</p> :
        <div className="pb-version-list">{suites.map((suite) => <div className="pb-version-row" key={suite.id}><Layers size={18} aria-hidden="true" /><div><strong>{suite.name}</strong><span className="pb-small pb-muted">v{suite.version} · {suite.cases.length} tests · {formatTime(suite.createdAt)}</span></div>
          <button className="pb-button" disabled={saving} aria-label={`Select ${suite.name} version ${suite.version}`} aria-pressed={selectedSuite?.id === suite.id} onClick={() => selectSuite(suite)}>{selectedSuite?.id === suite.id ? 'Selected' : 'Select version'}</button>
          <button className="pb-button" disabled={saving} onClick={() => {
            if (hasDraftChanges && !window.confirm('Replace the unsaved draft with this saved version? Your unsaved changes will be lost.')) return;
            const draft = suite.cases.length ? suite.cases.map((item) => ({ ...item })) : [newCase()];
            setName(suite.name); setCases(draft); setActiveId(draft[0]?.id ?? ''); setValidation(false); dirty(); setEditorOpen(true);
          }}>Use as draft</button>
          <details className="pb-saved-review"><summary>Review {suite.cases.length} {suite.cases.length === 1 ? 'test' : 'tests'}</summary>
            <ol>{suite.cases.map((item) => <li key={item.id}><h3>{item.question}</h3><p><strong>Expected answer</strong> {item.expectedAnswer}</p>
              <span className="pb-small pb-muted">{item.category}{item.critical ? ' · Critical' : ''}</span></li>)}</ol>
          </details>
          <details><summary>Version details</summary><p>Content hashes identify content, not signed compliance attestations.</p><dl className="pb-definition"><dt>Version ID</dt><dd><code>{suite.id}</code></dd><dt>Content hash</dt><dd><code>{suite.hash}</code></dd></dl></details></div>)}</div>}
    </div>
    <details className="pb-editor-details" open={editorOpen} onToggle={(event) => setEditorOpen(event.currentTarget.open)}>
      <summary>Create or edit a test suite</summary>
    <p className="pb-small pb-muted pb-draft-note">Editing a draft does not change the selected immutable version. Saving selects the new version unless the workspace changed during the save.</p>
    <div className="pb-suite-toolbar"><label className="pb-field pb-suite-name">Suite name<input value={name} maxLength={160} placeholder="Name your test suite" onChange={(event) => { setName(event.target.value); dirty(); }} aria-invalid={validation && !name.trim()} disabled={saving} />
      {validation && !name.trim() && <span className="pb-field-error">A suite name is required.</span>}</label>
      <div className="pb-suite-actions"><span className="pb-tag">{ack ? `SAVED · V${ack.version}` : 'UNSAVED DRAFT'}</span><button className="pb-button pb-primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving to cloud…' : 'Save immutable version'}<Cloud size={16} aria-hidden="true" /></button></div>
    </div>
    {validation && invalidCases.length > 0 && <Notice error>Each case needs a question and an expected answer within the field limits. Review {invalidCases.length} invalid {invalidCases.length === 1 ? 'case' : 'cases'}.</Notice>}
    {error && <Notice error>{error} Your draft is still here. Verify saved versions before retrying a timed-out save.</Notice>}
    {ack && <Notice>Saved “{ack.name}” version {ack.version} to the cloud at {formatTime(ack.createdAt)}. This version is immutable.</Notice>}
    <div className="pb-editor-grid">
      <aside className="pb-question-pane"><div className="pb-pane-heading"><h2>Questions</h2><span className="pb-tag">{cases.length}</span></div>
        <div className="pb-question-list">{cases.map((item, index) => <button key={item.id} disabled={saving} className={`pb-question-row ${selected?.id === item.id ? 'is-selected' : ''}`} onClick={() => setActiveId(item.id)}>
          <span className="pb-question-number">{String(index + 1).padStart(2, '0')}</span><span><strong>{item.question || 'Untitled question'}</strong><span className="pb-small pb-muted">{item.category || 'Uncategorized'}{item.critical ? ' · Critical' : ''}</span></span>
          {validation && (!item.question.trim() || !item.expectedAnswer.trim()) && <CircleAlert size={16} aria-label="Incomplete case" />}
        </button>)}</div>
        <button className="pb-button pb-add-question" disabled={saving || cases.length >= suiteLimits.cases} onClick={() => {
          const item = newCase(); setCases((items) => [...items, item]); setActiveId(item.id); dirty();
          setTimeout(() => editor.current?.focus(), 0);
        }}><Plus size={16} aria-hidden="true" /> Add question</button>
        <p className="pb-small pb-muted">Up to 30 cases per version.<br />Drafts are not stored in this browser.</p>
      </aside>
      {selected && <><div className="pb-case-pane"><div className="pb-pane-heading"><h2>Question editor</h2><span className="pb-eyebrow">INPUT</span></div>
        <label className="pb-field">Question<textarea ref={editor} value={selected.question} maxLength={suiteLimits.question} placeholder="What should the data agent be able to answer?" disabled={saving}
          aria-invalid={validation && (!selected.question.trim() || selected.question.length > suiteLimits.question)} onChange={(event) => update({ question: event.target.value })} /></label>
        {validation && !selected.question.trim() && <p className="pb-field-error">Question is required.</p>}
        <p className="pb-small pb-muted">{selected.question.length} / {suiteLimits.question} characters</p>
        {validation && selected.question.length > suiteLimits.question && <p className="pb-field-error">Question must be 1,000 characters or fewer.</p>}
        <label className="pb-field">Category <span className="pb-optional">(optional)</span><input value={selected.category} maxLength={suiteLimits.category} placeholder="Optional category" disabled={saving} aria-invalid={validation && selected.category.length > suiteLimits.category} onChange={(event) => update({ category: event.target.value })} /></label>
        {validation && selected.category.length > suiteLimits.category && <p className="pb-field-error">Category must be 80 characters or fewer.</p>}
        <label className="pb-checkbox"><input type="checkbox" checked={selected.critical} disabled={saving} onChange={(event) => update({ critical: event.target.checked })} /><span><strong>Critical case</strong><span className="pb-small pb-muted">Flag this question as essential to evaluation review.</span></span></label>
        <button className="pb-text-button pb-remove" disabled={saving || cases.length <= 1} onClick={() => {
          const remaining = cases.filter((item) => item.id !== selected.id); setCases(remaining); setActiveId(remaining[0]?.id ?? ''); dirty();
        }}><X size={15} aria-hidden="true" /> Remove question</button>
      </div><div className="pb-answer-pane"><div className="pb-pane-heading"><h2>Expected answer</h2><span className="pb-eyebrow">REFERENCE</span></div>
        <label className="pb-field">Expected answer<textarea value={selected.expectedAnswer} maxLength={suiteLimits.answer} placeholder="Describe the verified answer, key facts, and acceptable scope." disabled={saving}
          aria-invalid={validation && (!selected.expectedAnswer.trim() || selected.expectedAnswer.length > suiteLimits.answer)} onChange={(event) => update({ expectedAnswer: event.target.value })} /></label>
        {validation && !selected.expectedAnswer.trim() && <p className="pb-field-error">Expected answer is required.</p>}
        <p className="pb-small pb-muted">{selected.expectedAnswer.length} / {suiteLimits.answer} characters</p>
        {validation && selected.expectedAnswer.length > suiteLimits.answer && <p className="pb-field-error">Expected answer must be 1,500 characters or fewer.</p>}
        <div className="pb-reference-note"><BookOpen size={18} aria-hidden="true" /><p>Use a trusted reference. Expected answers are test definitions, not verified agent results. No scoring is performed when saving.</p></div>
      </div></>}
    </div>
    </details>
  </section></>;
}
