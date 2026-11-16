import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidProofbenchResponseError, JobThrottledError, UncertainRunWriteError, parseAgents, parseBootstrap, parseSavedSuite, parseRun, parseJobStatus,
  proofbenchService,
} from './proofbench.service';
import { getRayfinClient } from '../lib/rayfin-client';
import { NetworkError } from '@microsoft/rayfin-lib';

vi.mock('../lib/rayfin-client', () => ({ getRayfinClient: vi.fn() }));

const now = '2026-11-11T12:00:00Z';
const workspace = { id: '11111111-1111-4111-8111-111111111111', name: 'Authorized workspace' };
const testCase = { id: 'case-1', question: 'Fictional question?', expectedAnswer: 'Fictional answer.', category: '', critical: true };
const suite = { id: 'suite-1', name: 'Fictional suite', version: 1, createdAt: now, cases: [testCase], hash: 'real-content-hash' };
const bootstrap = {
  workspace, workspaces: [workspace], suiteVersions: [suite], runs: [],
  capabilities: { cloudOnly: true, evaluationExecution: false }, checkedAt: now,
  workspacesComplete: true, suitesComplete: true, runsComplete: true, executionBlocker: 'Not configured.',
};
const inventory = {
  agents: [{ id: 'agent-1', name: '<script>inert text</script>', workspaceId: workspace.id, workspaceName: workspace.name }],
  complete: true, checkedAt: now,
};
const run = {
  id: 'run-1', requestId: '11111111-1111-4111-8111-111111111111', target: { ...inventory.agents[0], stage: 'sandbox', publicationVerified: false },
  suite: { id: suite.id, name: suite.name, version: suite.version, hash: suite.hash, caseCount: 1 },
  createdAt: now, approvalDigest: 'digest', status: 'awaiting_approval',
};
const receipt = { workspaceId: workspace.id, notebookId: 'notebook-1', jobId: 'job-1', acceptedAt: now, firstPollAfterSeconds: 30 };
const acceptedRun = { ...run, status: 'job_accepted', job: receipt };
const observation = { state: 'job_running', checkedAt: now, nextPollAfterSeconds: 10 };

beforeEach(() => { vi.clearAllMocks(); });

describe('Proofbench cloud response validation', () => {
  it('maps backend configuration and access errors without exposing backend messages', () => {
    for (const [code, name] of [['CONFIGURATION_ERROR', 'BackendConfigurationError'], ['PILOT_ACCESS_DENIED', 'BackendAccessError'], ['TENANT_SCOPE', 'BackendAccessError']]) {
      try { parseBootstrap(JSON.stringify({ error: { code, message: 'private value' } })); throw new Error('Expected failure'); }
      catch (error) { expect(error).toHaveProperty('name', name); expect(String(error)).not.toContain('private value'); }
    }
  });
  it('accepts verified contract shapes without treating strings as HTML', () => {
    expect(parseBootstrap(JSON.stringify(bootstrap))).toEqual(bootstrap);
    expect(parseAgents(JSON.stringify(inventory))).toEqual(inventory);
    expect(parseSavedSuite(JSON.stringify({ suite }))).toEqual(suite);
    expect(parseRun(JSON.stringify({ run }))).toEqual(run);
    expect(parseBootstrap({ ...bootstrap, runs: [run] }).runs).toEqual([run]);
  });

  it('accepts objects already decoded by the installed Functions SDK', () => {
    expect(parseBootstrap(bootstrap)).toEqual(bootstrap);
    expect(parseAgents(inventory)).toEqual(inventory);
    expect(parseSavedSuite({ suite })).toEqual(suite);
    for (const invalid of [null, undefined, [], 42, true, { error: { code: 'ACCESS_DENIED' } }]) {
      expect(() => parseBootstrap(invalid)).toThrow(InvalidProofbenchResponseError);
    }
  });

  it.each([
    'not JSON', '{}', 'null',
    JSON.stringify({ ...bootstrap, checkedAt: 'not a date' }),
    JSON.stringify({ ...bootstrap, workspacesComplete: 'true' }),
    JSON.stringify({ ...bootstrap, capabilities: { cloudOnly: false, evaluationExecution: true } }),
    JSON.stringify({ ...bootstrap, runs: [{ id: 'invented-run' }] }),
    JSON.stringify({ ...bootstrap, suiteVersions: [{ ...suite, hash: '' }] }),
  ])('rejects malformed or unsupported bootstrap data', (value) => {
    expect(() => parseBootstrap(value)).toThrow(InvalidProofbenchResponseError);
  });

  it.each([
    { ...suite, version: 0 },
    { ...suite, version: 1.5 },
    { ...suite, cases: [] },
    { ...suite, cases: [testCase, testCase] },
    { ...suite, cases: [{ ...testCase, critical: 'true' }] },
    { ...suite, cases: [{ ...testCase, expectedAnswer: ' ' }] },
    { ...suite, cases: [{ ...testCase, question: 'x'.repeat(1001) }] },
    { ...suite, cases: [{ ...testCase, expectedAnswer: 'x'.repeat(1501) }] },
    { ...suite, cases: [{ ...testCase, category: 'x'.repeat(81) }] },
    { ...suite, cases: Array.from({ length: 31 }, (_, index) => ({ ...testCase, id: `case-${index}` })) },
  ])('rejects invalid immutable suite versions', (value) => {
    expect(() => parseSavedSuite(JSON.stringify({ suite: value }))).toThrow(InvalidProofbenchResponseError);
  });

  it('rejects incomplete inventory envelopes', () => {
    expect(() => parseAgents(JSON.stringify({ agents: [] }))).toThrow(InvalidProofbenchResponseError);
  });

  it.each([
    { ...run, target: { ...run.target, stage: 'unknown' } },
    { ...run, target: { ...run.target, publicationVerified: true } },
    { ...run, status: 'running' },
    { ...run, approvalDigest: '' },
    { ...run, requestId: 'not-a-uuid' },
    { ...run, requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    { ...run, suite: { ...run.suite, caseCount: 0 } },
    { ...run, suite: { ...run.suite, version: 1.5 } },
    { ...run, approvedAt: 'invalid' },
  ])('rejects malformed run records', (invalid) => {
    expect(() => parseRun({ run: invalid })).toThrow(InvalidProofbenchResponseError);
  });

  it('maps run errors without exposing backend text', () => {
    for (const code of ['RUN_STALE', 'RUN_REQUEST_CONFLICT', 'RUN_NOT_FOUND', 'RUN_RECORD_INVALID', 'AMBIGUOUS_SUITE', 'INVALID_AGENT', 'FEATURE_DISABLED', 'RUN_ALREADY_CLAIMED']) {
      try { parseRun({ error: { code, message: 'private value' } }); throw new Error('Expected failure'); }
      catch (error) { expect(error).toHaveProperty('name', 'BackendRunError'); expect(String(error)).not.toContain('private value'); }
    }
  });

  it('validates a receipt and each supported job observation', () => {
    expect(parseRun({ run: acceptedRun })).toEqual(acceptedRun);
    expect(parseBootstrap({ ...bootstrap, runs: [acceptedRun] }).runs).toEqual([acceptedRun]);
    expect(parseJobStatus({ run: acceptedRun, job: null }, run.id)).toEqual({ run: acceptedRun, job: null });
    for (const state of ['job_not_started', 'job_running', 'job_completed_unverified', 'job_failed', 'job_cancelled', 'job_deduped']) {
      expect(parseJobStatus({ run: acceptedRun, job: { ...observation, state, nextPollAfterSeconds: null } }, run.id).job?.state).toBe(state);
    }
  });
  it.each([0, 60, 86400])('parses a safe throttling delay of %s seconds', (delay) => {
    try {
      parseJobStatus({ error: { code: 'JOB_THROTTLED', message: 'private provider detail', retryAfterSeconds: delay } }, run.id);
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(JobThrottledError);
      expect(error).toHaveProperty('retryAfterSeconds', delay);
      expect(String(error)).not.toContain('private provider detail');
    }
  });
  it.each([undefined, null, -1, 86401, 0.5, '60', NaN])('treats a missing or invalid throttling delay as unknown: %s', (delay) => {
    try {
      parseJobStatus(JSON.stringify({ error: { code: 'JOB_THROTTLED', message: 'private', retryAfterSeconds: delay } }), run.id);
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(JobThrottledError);
      expect(error).toHaveProperty('retryAfterSeconds', null);
      expect(String(error)).not.toContain('private');
    }
  });

  it('rejects mismatched IDs, malformed receipts and malformed job observations', () => {
    const invalidRuns = [
      { ...acceptedRun, job: undefined }, { ...acceptedRun, job: null },
      { ...acceptedRun, job: { ...receipt, jobId: '' } },
      { ...acceptedRun, job: { ...receipt, acceptedAt: 'bad' } },
      { ...acceptedRun, job: { ...receipt, firstPollAfterSeconds: -1 } },
      { ...acceptedRun, job: { ...receipt, firstPollAfterSeconds: 0.5 } },
    ];
    for (const invalid of invalidRuns) expect(() => parseRun({ run: invalid })).toThrow(InvalidProofbenchResponseError);
    for (const invalid of [
      undefined, {}, { ...observation, state: 'completed' }, { ...observation, checkedAt: 'bad' },
      { ...observation, nextPollAfterSeconds: -1 }, { ...observation, nextPollAfterSeconds: '10' },
    ]) expect(() => parseJobStatus({ run: acceptedRun, job: invalid }, run.id)).toThrow(InvalidProofbenchResponseError);
    expect(() => parseJobStatus({ run: acceptedRun, job: observation }, 'another-run')).toThrow(InvalidProofbenchResponseError);
  });

  it.each([['RUN_SAVE_UNCERTAIN', 'create'], ['APPROVAL_UNCERTAIN', 'approve']] as const)(
    'maps %s to a distinct safe uncertainty error', (code, operation) => {
      try { parseRun({ error: { code, message: 'private value' } }); throw new Error('Expected failure'); }
      catch (error) {
        expect(error).toBeInstanceOf(UncertainRunWriteError);
        expect(error).toHaveProperty('operation', operation);
        expect(String(error)).not.toContain('private value');
      }
    },
  );
});

describe('Proofbench typed function adapter', () => {
  it('requests the selected run status once and rejects a different run', async () => {
    const invoke = vi.fn().mockResolvedValue({ run: acceptedRun, job: observation });
    vi.mocked(getRayfinClient).mockResolvedValue({
      functions: { proofbenchRunStatus: { invoke } },
    } as unknown as Awaited<ReturnType<typeof getRayfinClient>>);
    await expect(proofbenchService.runStatus(run.id)).resolves.toEqual({ run: acceptedRun, job: observation });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith({ runId: run.id }, { timeoutMs: 25000 });
    await expect(proofbenchService.runStatus('other-run')).rejects.toThrow(InvalidProofbenchResponseError);
  });
  it('does not expose provider failures during status refresh', async () => {
    vi.mocked(getRayfinClient).mockResolvedValue({
      functions: { proofbenchRunStatus: { invoke: vi.fn().mockRejectedValue(new Error('private provider details')) } },
    } as unknown as Awaited<ReturnType<typeof getRayfinClient>>);
    await expect(proofbenchService.runStatus(run.id)).rejects.toThrow('Job status could not be refreshed.');
  });
  it('treats an SDK HTTP 429 with no accessible body as an unknown throttling delay', async () => {
    vi.mocked(getRayfinClient).mockResolvedValue({
      functions: { proofbenchRunStatus: { invoke: vi.fn().mockRejectedValue(new NetworkError('private body', 429)) } },
    } as unknown as Awaited<ReturnType<typeof getRayfinClient>>);
    await expect(proofbenchService.runStatus(run.id)).rejects.toMatchObject({ name: 'JobThrottledError', retryAfterSeconds: null });
  });
  it('preserves a throttling error returned in the function output', async () => {
    vi.mocked(getRayfinClient).mockResolvedValue({
      functions: { proofbenchRunStatus: { invoke: vi.fn().mockResolvedValue({ error: { code: 'JOB_THROTTLED', message: 'private', retryAfterSeconds: 30 } }) } },
    } as unknown as Awaited<ReturnType<typeof getRayfinClient>>);
    await expect(proofbenchService.runStatus(run.id)).rejects.toMatchObject({ name: 'JobThrottledError', retryAfterSeconds: 30 });
  });
  it('handles the actual SDK-decoded outputs for every hosted function', async () => {
    vi.mocked(getRayfinClient).mockResolvedValue({
      functions: {
        proofbenchBootstrap: { invoke: vi.fn().mockResolvedValue(bootstrap) },
        proofbenchAgents: { invoke: vi.fn().mockResolvedValue(inventory) },
        proofbenchSaveSuite: { invoke: vi.fn().mockResolvedValue({ suite }) },
      },
    } as unknown as Awaited<ReturnType<typeof getRayfinClient>>);
    await expect(proofbenchService.bootstrap()).resolves.toEqual(bootstrap);
    await expect(proofbenchService.listAgents(workspace.id)).resolves.toEqual(inventory);
    await expect(proofbenchService.saveSuite({ name: suite.name, cases: suite.cases })).resolves.toEqual(suite);
  });

  it('uses only the agreed authenticated functions and their exact input envelopes', async () => {
    const bootstrapInvoke = vi.fn().mockResolvedValue(JSON.stringify(bootstrap));
    const agentsInvoke = vi.fn().mockResolvedValue(JSON.stringify(inventory));
    const saveInvoke = vi.fn().mockResolvedValue(JSON.stringify({ suite }));
    const createInvoke = vi.fn().mockResolvedValue(JSON.stringify({ run }));
    const approveInvoke = vi.fn().mockResolvedValue(JSON.stringify({ run: { ...run, status: 'approved', approvedAt: now } }));
    vi.mocked(getRayfinClient).mockResolvedValue({
      functions: {
        proofbenchBootstrap: { invoke: bootstrapInvoke },
        proofbenchAgents: { invoke: agentsInvoke },
        proofbenchSaveSuite: { invoke: saveInvoke },
        proofbenchCreateRun: { invoke: createInvoke },
        proofbenchApproveRun: { invoke: approveInvoke },
      },
    } as unknown as Awaited<ReturnType<typeof getRayfinClient>>);
    await expect(proofbenchService.bootstrap()).resolves.toEqual(bootstrap);
    await expect(proofbenchService.listAgents(workspace.id)).resolves.toEqual(inventory);
    const input = { name: suite.name, cases: suite.cases };
    await expect(proofbenchService.saveSuite(input)).resolves.toEqual(suite);
    expect(bootstrapInvoke).toHaveBeenCalledWith(undefined, { timeoutMs: 25000 });
    expect(agentsInvoke).toHaveBeenCalledWith({ workspaceId: workspace.id }, { timeoutMs: 25000 });
    expect(saveInvoke).toHaveBeenCalledWith({
      suiteJson: JSON.stringify({ name: input.name, cases: [{
        question: testCase.question, expectedAnswer: testCase.expectedAnswer,
        category: testCase.category, critical: testCase.critical,
      }] }),
    }, { timeoutMs: 25000 });
    const selection = { workspaceId: workspace.id, agentId: 'agent-1', suiteId: suite.id, stage: 'sandbox' as const };
    await expect(proofbenchService.createRun(selection, 'request-1')).resolves.toEqual(run);
    await expect(proofbenchService.approveRun(run.id, run.approvalDigest)).resolves.toEqual({ ...run, status: 'approved', approvedAt: now });
    expect(createInvoke).toHaveBeenCalledWith({ selectionJson: JSON.stringify(selection), requestId: 'request-1' }, { timeoutMs: 25000 });
    expect(approveInvoke).toHaveBeenCalledWith({ runId: run.id, approvalDigest: run.approvalDigest }, { timeoutMs: 25000 });
    expect(getRayfinClient).toHaveBeenCalledTimes(5);
  });

  it('rejects an agent returned from a different source workspace', async () => {
    vi.mocked(getRayfinClient).mockResolvedValue({
      functions: { proofbenchAgents: { invoke: vi.fn().mockResolvedValue(JSON.stringify(inventory)) } },
    } as unknown as Awaited<ReturnType<typeof getRayfinClient>>);
    await expect(proofbenchService.listAgents('another-workspace')).rejects.toThrow(InvalidProofbenchResponseError);
  });
});
