import test from 'node:test';
import assert from 'node:assert/strict';
import { notebookJobStatusUrl, parseNotebookJobStatus, parseNotebookReceipt } from '../dist/notebook-job-protocol.js';

const WORKSPACE = 'a0a00001-1234-4abc-8def-000000000001';
const NOTEBOOK = 'a0a00002-1234-4abc-8def-000000000002';
const JOB = 'a0a00003-1234-4abc-8def-000000000003';
const OTHER = 'a0a00004-1234-4abc-8def-000000000004';
const path = `/v1/workspaces/${WORKSPACE}/items/${NOTEBOOK}/jobs/instances/${JOB}`;

test('accepted receipts preserve the server poll delay and reconstruct a fixed-origin URL', () => {
  for (const host of ['https://api.fabric.microsoft.com', 'https://wabi-example.analysis.windows.net']) {
    const result = parseNotebookReceipt(202, host + path, '60', WORKSPACE, NOTEBOOK);
    assert.deepEqual(result, { jobId: JOB, firstPollAfterSeconds: 60 });
    assert.equal(notebookJobStatusUrl(WORKSPACE, NOTEBOOK, result.jobId), 'https://api.fabric.microsoft.com' + path);
  }
  const legacy = `https://api.fabric.microsoft.com/v1/workspaces/${WORKSPACE}/notebooks/${NOTEBOOK}/jobs/execute/instances/${JOB}`;
  assert.equal(parseNotebookReceipt(202, legacy, '0', WORKSPACE, NOTEBOOK).jobId, JOB);
});

test('ambiguous receipts fail closed and never supply a retryable submission', () => {
  const valid = 'https://api.fabric.microsoft.com' + path;
  const cases = [
    [200, valid, '10'], [202, null, '10'], [202, valid, null], [202, valid, '-1'],
    [202, valid, '1.5'], [202, valid, '86401'], [202, valid, ' 10'],
    [202, 'https://attacker.invalid' + path, '10'], [202, 'http://api.fabric.microsoft.com' + path, '10'],
    [202, 'https://api.fabric.microsoft.com.evil.invalid' + path, '10'],
    [202, ['https://user:pass', 'api.fabric.microsoft.com'].join('@') + path, '10'],
    [202, valid + '?jobType=RunNotebook', '10'], [202, valid + '#fragment', '10'], [202, ' ' + valid, '10'],
    [202, valid.replace(WORKSPACE, OTHER), '10'], [202, valid.replace(NOTEBOOK, OTHER), '10'],
    [202, valid.replace(JOB, 'not-a-uuid'), '10'],
    [202, `https://api.fabric.microsoft.com/v1/workspaces/${WORKSPACE}/items/${NOTEBOOK}/jobs/instances`, '10'],
  ];
  for (const [status, location, delay] of cases) {
    assert.throws(() => parseNotebookReceipt(status, location, delay, WORKSPACE, NOTEBOOK),
      error => error.code === 'JOB_SUBMISSION_UNCERTAIN' && !error.message.includes('attacker'));
  }
});

test('job completion is explicitly unverified and provider error details never escape', () => {
  const row = { id: JOB, itemId: NOTEBOOK, jobType: 'RunNotebook', invokeType: 'Manual', failureReason: null };
  const cases = [
    ['NotStarted', 'job_not_started'], ['InProgress', 'job_running'], ['Completed', 'job_completed_unverified'],
    ['Failed', 'job_failed'], ['Cancelled', 'job_cancelled'], ['Deduped', 'job_deduped'],
  ];
  for (const [status, expected] of cases) assert.equal(parseNotebookJobStatus({ ...row, status }, NOTEBOOK, JOB), expected);
  assert.equal(parseNotebookJobStatus({ ...row, invokeType: 'OnDemand', status: 'Completed' }, NOTEBOOK, JOB), 'job_completed_unverified');
  assert.equal(parseNotebookJobStatus({ ...row, status: 'Failed', failureReason: { message: 'private provider content' } }, NOTEBOOK, JOB), 'job_failed');
  for (const invalid of [
    { ...row, id: OTHER, status: 'Completed' }, { ...row, itemId: OTHER, status: 'Completed' },
    { ...row, jobType: 'Other', status: 'Completed' }, { ...row, invokeType: 'Scheduled', status: 'Completed' },
    { ...row, status: 'Completed', failureReason: { message: 'private provider content' } },
    { ...row, status: 'Unknown' }, null,
  ]) {
    assert.throws(() => parseNotebookJobStatus(invalid, NOTEBOOK, JOB),
      error => error.code === 'JOB_STATUS_INVALID' && !error.message.includes('private'));
  }
});
