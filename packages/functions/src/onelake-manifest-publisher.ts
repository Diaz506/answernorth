import type { Agent } from '@rayfin-app/shared';
import type { Request } from './metadata.js';
import { submissionClaimId } from './runs.js';
import { SafeError, storageToken, uuid, type DeploymentConfig, type JobExecutionConfig } from './safety.js';
import type { Store } from './suites.js';
import { createWorkerManifest } from './worker-manifest.js';

const ORIGIN = 'https://onelake.blob.fabric.microsoft.com';
const ENVELOPE_LIMIT = 1_000_000;
const TIMEOUT_MS = 30_000;
const UNCERTAIN = 'The manifest write could not be confirmed. Reconcile it before any retry.';
const ETAG = /^"[\x21\x23-\x7e]{1,200}"$/;

export interface ManifestStorageConfig {
  workspaceId: string;
  lakehouseId: string;
}

function configId(value: unknown): string {
  try {
    const id = uuid(value);
    if (id !== value) throw new Error();
    return id;
  } catch {
    throw new SafeError('CONFIGURATION_ERROR', 'The manifest storage configuration is invalid.');
  }
}

async function discard(response: Response): Promise<void> {
  if (response.body) await response.body.cancel();
}

async function readVerified(response: Response, expected: Uint8Array, etag: string): Promise<void> {
  if (response.status !== 200 || response.headers.get('etag') !== etag ||
      response.headers.get('x-ms-rejected-headers') ||
      (response.headers.get('content-encoding') && response.headers.get('content-encoding')?.toLowerCase() !== 'identity')) {
    await discard(response);
    throw new Error();
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d{1,10}$/.test(length) || Number(length) !== expected.byteLength)) {
    await discard(response);
    throw new Error();
  }
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expected.byteLength || offset + value.byteLength > ENVELOPE_LIMIT ||
          !Buffer.from(value).equals(Buffer.from(expected.subarray(offset, offset + value.byteLength)))) {
        await reader.cancel();
        throw new Error();
      }
      offset += value.byteLength;
    }
    if (offset !== expected.byteLength) throw new Error();
  } finally { reader.releaseLock(); }
}

/**
 * Internal candidate only. No public function or coordinator calls this method.
 * The host must authenticate the token; checking claims does not verify its signature.
 */
export async function publishWorkerManifest(
  store: Store,
  deployment: DeploymentConfig,
  execution: JobExecutionConfig,
  location: ManifestStorageConfig,
  key: Buffer,
  injectedStorageToken: string,
  runId: string,
  resolveAgent: (workspaceId: string, agentId: string) => Promise<Agent>,
  request: Request,
): Promise<{ state: 'stored_unverified'; etag: string }> {
  const workspaceId = configId(location.workspaceId);
  const lakehouseId = configId(location.lakehouseId);
  const ownerId = configId(deployment.ownerId);
  if (typeof request !== 'function') throw new SafeError('CONFIGURATION_ERROR', 'The manifest transport is unavailable.');
  const token = storageToken(injectedStorageToken, ownerId, deployment);
  const run = uuid(runId);
  const attempt = submissionClaimId(ownerId, run);
  const url = `${ORIGIN}/${workspaceId}/${lakehouseId}/Files/answernorth/manifests/${run}/${attempt}.json`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writeStarted = false;
  try {
    return await Promise.race([
      (async () => {
        const envelope = await createWorkerManifest(store, deployment, execution, key, run, resolveAgent);
        const bytes = Buffer.from(envelope, 'utf8');
        if (bytes.length > ENVELOPE_LIMIT) throw new SafeError('MANIFEST_TOO_LARGE', 'The worker manifest exceeds its size limit.');
        if (controller.signal.aborted) throw new Error();
        writeStarted = true;
        const put = await request(url, {
          method: 'PUT', redirect: 'error', signal: controller.signal, body: bytes,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
            'Content-Length': String(bytes.length), 'x-ms-blob-type': 'BlockBlob',
            'x-ms-version': '2023-08-03', 'If-None-Match': '*' },
        });
        if (controller.signal.aborted) throw new Error();
        const etag = put.headers.get('etag');
        const rejected = put.headers.get('x-ms-rejected-headers');
        const providerCode = put.headers.get('x-ms-error-code');
        const status = put.status;
        await discard(put);
        if (controller.signal.aborted) throw new Error();
        if (rejected) throw new Error();
        if (status === 412 || (status === 409 && providerCode === 'BlobAlreadyExists')) {
          throw new SafeError('MANIFEST_CONFLICT', 'A manifest already exists for this attempt. Reconcile it before retrying.');
        }
        if (status !== 201 || !etag || !ETAG.test(etag)) throw new Error();
        const saved = await request(url, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
            'x-ms-version': '2023-08-03', 'If-Match': etag },
        });
        await readVerified(saved, bytes, etag);
        if (controller.signal.aborted) throw new Error();
        return { state: 'stored_unverified' as const, etag };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(writeStarted ? new SafeError('MANIFEST_PUBLISH_UNCERTAIN', UNCERTAIN)
            : new SafeError('MANIFEST_PREPARATION_TIMEOUT', 'Manifest preparation timed out before any storage write.'));
        }, TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof SafeError && error.code === 'MANIFEST_CONFLICT') throw error;
    if (!writeStarted && error instanceof SafeError) throw error;
    if (!writeStarted) throw new SafeError('MANIFEST_PREPARATION_FAILED', 'The manifest could not be prepared. No storage write was attempted.');
    throw new SafeError('MANIFEST_PUBLISH_UNCERTAIN', UNCERTAIN);
  } finally { if (timer) clearTimeout(timer); }
}
