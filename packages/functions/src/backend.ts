import { AudienceType, type RayfinContext } from '@microsoft/fabric-user-data-functions';
import type { Bootstrap, ProofbenchRecord, UniversalAppSchema } from '@rayfin-app/shared';
import { Metadata, type Request } from './metadata.js';
import { deploymentConfig, EXECUTION_BLOCKER, fabricToken, jobExecutionConfig, pilotOwner, SafeError, safeResult, uuid } from './safety.js';
import { Suites, type Store } from './suites.js';
import { probeAgent } from './probe.js';
import { parseRunSelection, prepareRun } from './run-preparation.js';
import { RunLedger, validApprovalDigest } from './runs.js';
import { NotebookJobClient } from './notebook-job-client.js';

type Context = RayfinContext<UniversalAppSchema, AudienceType.Fabric>;
const FIELDS: (keyof ProofbenchRecord)[] = ['id', 'owner_id', 'kind', 'suiteId', 'createdAt', 'payload'];

export function platformStore(ctx: Pick<Context, 'getDataClient'>): Store {
  const entity = ctx.getDataClient().ProofbenchRecord;
  return {
    async manifests(owner, familyId) {
      return entity.select(FIELDS)
        .where({ owner_id: { eq: owner }, kind: { eq: 'manifest' }, ...(familyId ? { suiteId: { eq: familyId } } : {}) })
        .orderBy({ createdAt: 'desc', id: 'desc' }).first(100).executePaginated();
    },
    async runs(owner) {
      return entity.select(FIELDS).where({ owner_id: { eq: owner }, kind: { eq: 'run' } })
        .orderBy({ createdAt: 'desc', id: 'desc' }).first(25).executePaginated();
    },
    async guardPage(owner, scopeId, kind, cursor) {
      let query = entity.select(FIELDS).where({ owner_id: { eq: owner }, kind: { eq: kind }, suiteId: { eq: scopeId } })
        .orderBy({ createdAt: 'desc', id: 'desc' }).first(100);
      if (cursor) query = query.after(cursor);
      return query.executePaginated();
    },
    async record(owner, id) {
      // findById defaults to PK-only in this SDK; select every protocol field explicitly.
      const rows = await entity.select(FIELDS).where({ id: { eq: uuid(id) }, owner_id: { eq: owner } }).first(1).execute();
      return rows[0];
    },
    async create(row) { await entity.create(row); },
  };
}

/** Dependency seams are internal modules, never UDF parameters or browser overrides. */
export function backend(ctx: Context, dependencies: { store?: Store; request?: Request } = {}) {
  const disabled = (): Promise<string> => safeResult(async () => {
    const config = deploymentConfig(ctx);
    pilotOwner(ctx.accessToken, config);
    fabricToken(ctx.Tokens.Fabric, config);
    throw new SafeError('FEATURE_DISABLED', 'This feature is disabled; no request was submitted and no result was generated.');
  });
  return {
    bootstrap: (): Promise<string> => safeResult(async () => {
      const config = deploymentConfig(ctx);
      const owner = pilotOwner(ctx.accessToken, config);
      const metadata = new Metadata(ctx.Tokens.Fabric, config, dependencies.request);
      const workspace = await metadata.workspace(config.workspaceId);
      const discovery = await metadata.workspaces();
      const store = dependencies.store ?? platformStore(ctx);
      const history = await new Suites(store, owner).history();
      const runs = await new RunLedger(store, owner).history();
      const result: Bootstrap = {
        workspace, workspaces: discovery.workspaces, suiteVersions: history.suites, runs: runs.runs,
        capabilities: { cloudOnly: true, evaluationExecution: false },
        checkedAt: new Date().toISOString(), workspacesComplete: discovery.complete, suitesComplete: history.complete, runsComplete: runs.complete,
        executionBlocker: EXECUTION_BLOCKER,
      };
      return result;
    }),
    agents: (workspaceId: string): Promise<string> => safeResult(async () => {
      const config = deploymentConfig(ctx);
      pilotOwner(ctx.accessToken, config);
      return new Metadata(ctx.Tokens.Fabric, config, dependencies.request).agents(uuid(workspaceId));
    }),
    saveSuite: (suiteJson: string): Promise<string> => safeResult(async () => {
      const config = deploymentConfig(ctx);
      const owner = pilotOwner(ctx.accessToken, config);
      // Validate the platform Fabric token before accessing owner-scoped storage.
      new Metadata(ctx.Tokens.Fabric, config, dependencies.request);
      return { suite: await new Suites(dependencies.store ?? platformStore(ctx), owner).save(suiteJson) };
    }),
    probeAgent: (workspaceId: string, agentId: string): Promise<string> => safeResult(async () => {
      const config = deploymentConfig(ctx);
      pilotOwner(ctx.accessToken, config);
      return probeAgent(ctx.Tokens.Fabric, workspaceId, agentId, config, dependencies.request);
    }),
    // Not registered as a UDF: preparation is internal until its trust and execution contracts are reviewed.
    prepareRun: (selectionJson: string): Promise<string> => safeResult(async () => {
      const config = deploymentConfig(ctx);
      const owner = pilotOwner(ctx.accessToken, config);
      const metadata = new Metadata(ctx.Tokens.Fabric, config, dependencies.request);
      const selection = parseRunSelection(selectionJson);
      const suite = await new Suites(dependencies.store ?? platformStore(ctx), owner).getById(selection.suiteId);
      const agent = await metadata.agent(selection.workspaceId, selection.agentId);
      return { preparation: prepareRun(selection, agent, suite) };
    }),
    createRun: (selectionJson: string, requestId: string): Promise<string> => safeResult(async () => {
      const config = deploymentConfig(ctx);
      const owner = pilotOwner(ctx.accessToken, config);
      const metadata = new Metadata(ctx.Tokens.Fabric, config, dependencies.request);
      const selection = parseRunSelection(selectionJson);
      const request = uuid(requestId);
      const store = dependencies.store ?? platformStore(ctx);
      const suite = await new Suites(store, owner).getById(selection.suiteId);
      const agent = await metadata.agent(selection.workspaceId, selection.agentId);
      return { run: await new RunLedger(store, owner).create(request, prepareRun(selection, agent, suite)) };
    }),
    approveRun: (runId: string, approvalDigest: string): Promise<string> => safeResult(async () => {
      const config = deploymentConfig(ctx);
      const owner = pilotOwner(ctx.accessToken, config);
      const metadata = new Metadata(ctx.Tokens.Fabric, config, dependencies.request);
      const id = uuid(runId);
      const hash = validApprovalDigest(approvalDigest);
      const store = dependencies.store ?? platformStore(ctx);
      const ledger = new RunLedger(store, owner);
      const run = await ledger.get(id);
      const suite = await new Suites(store, owner).getById(run.suite.id);
      const agent = await metadata.agent(run.target.workspaceId, run.target.id);
      const selection = { workspaceId: run.target.workspaceId, agentId: run.target.id, suiteId: run.suite.id, stage: run.target.stage };
      return { run: await ledger.approve(id, hash, prepareRun(selection, agent, suite)) };
    }),
    // Deliberately never invokes the internal coordinator until a separately reviewed release.
    startRun: (_runId: string, _approvalDigest: string): Promise<string> => disabled(),
    runStatus: (runId: string): Promise<string> => safeResult(async () => {
      const config = deploymentConfig(ctx);
      const owner = pilotOwner(ctx.accessToken, config);
      fabricToken(ctx.Tokens.Fabric, config);
      const run = await new RunLedger(dependencies.store ?? platformStore(ctx), owner).get(uuid(runId));
      if (!run.job) return { run, job: null };
      const client = new NotebookJobClient(ctx.Tokens.Fabric, config, jobExecutionConfig(ctx), dependencies.request);
      return { run, job: await client.observe(run.job) };
    }),
    smokeStatus: (): Promise<string> => disabled(),
    submitSmoke: (_approvalHash: string): Promise<string> => disabled(),
    smokeEvidence: (_storageToken: string): Promise<string> => disabled(),
    aiQualification: (_action: string): Promise<string> => disabled(),
    suggestions: (_storageToken: string, _action: string, _requestJson: string): Promise<string> => disabled(),
  };
}
