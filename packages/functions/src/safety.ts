import { createHash } from 'node:crypto';

export const EXECUTION_BLOCKER = 'Evaluation execution is disabled. Saved suites can be authored and reviewed without running an evaluation.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SafeError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterSeconds?: number) { super(message); }
}

export interface DeploymentConfig { tenantId: string; workspaceId: string; appId: string; ownerId: string }
export interface JobExecutionConfig { workspaceId: string; notebookId: string }
type SecretContext = { getSecret(name: string): string | undefined };

function configUuid(ctx: SecretContext, name: string): string {
  let value: string | undefined;
  try { value = ctx.getSecret(name); }
  catch { throw new SafeError('CONFIGURATION_ERROR', `Required deployment setting ${name} is unavailable.`); }
  if (typeof value !== 'string' || !value || value !== value.trim() || !UUID.test(value) ||
      value.toLowerCase() === '00000000-0000-4000-8000-000000000000') {
    throw new SafeError('CONFIGURATION_ERROR', `Required deployment setting ${name} must be a valid UUID.`);
  }
  return value.toLowerCase();
}

/** Resolve configuration once per invocation from the platform context, never the browser. */
export function deploymentConfig(ctx: SecretContext): DeploymentConfig {
  const names = ['ANSWERNORTH_TENANT_ID', 'ANSWERNORTH_WORKSPACE_ID', 'ANSWERNORTH_APP_ID', 'ANSWERNORTH_OWNER_ID'] as const;
  const values = names.map(name => configUuid(ctx, name));
  return { tenantId: values[0], workspaceId: values[1], appId: values[2], ownerId: values[3] };
}

/** Separate server-only settings: required only when an actual job receipt is inspected. */
export function jobExecutionConfig(ctx: SecretContext): JobExecutionConfig {
  return {
    workspaceId: configUuid(ctx, 'ANSWERNORTH_JOB_WORKSPACE_ID'),
    notebookId: configUuid(ctx, 'ANSWERNORTH_JOB_NOTEBOOK_ID'),
  };
}

/** A dedicated 256-bit guard MAC key; never returned to a caller. */
export function jobGuardKey(ctx: SecretContext): Buffer {
  let value: string | undefined;
  try { value = ctx.getSecret('ANSWERNORTH_JOB_GUARD_KEY'); }
  catch { throw new SafeError('CONFIGURATION_ERROR', 'The notebook guard key is unavailable.'); }
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new SafeError('CONFIGURATION_ERROR', 'The notebook guard key must be a 256-bit base64url value.');
  }
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== value) {
    throw new SafeError('CONFIGURATION_ERROR', 'The notebook guard key must be a 256-bit base64url value.');
  }
  return key;
}

export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new SafeError('INVALID_ID', 'A valid workspace or record identifier is required.');
  }
  return value.toLowerCase();
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafeError('INVALID_INPUT', 'A JSON object is required.');
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string') throw new SafeError('INVALID_INPUT', 'Required text is missing.');
  const normalized = value.normalize('NFC').trim();
  if (normalized.length < min || normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(normalized)) {
    throw new SafeError('INVALID_INPUT', 'Text is empty, too long, or contains unsupported control characters.');
  }
  return normalized;
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function stableId(value: unknown): string {
  const hex = digest(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function claims(token: string): Record<string, unknown> {
  try {
    if (typeof token !== 'string' || token.length > 32768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const parsed = object(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')));
    if (typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp) || parsed.exp * 1000 <= Date.now()) throw new Error();
    if (typeof parsed.nbf === 'number' && parsed.nbf * 1000 > Date.now() + 30000) throw new Error();
    return parsed;
  } catch {
    throw new SafeError('AUTH_REQUIRED', 'A valid, unexpired platform authentication context is required.');
  }
}

/** The host authenticates the signature; these checks only constrain injected context. */
export function callerOwner(token: string): string {
  const payload = claims(token);
  if (typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 1024 || payload.sub.trim() !== payload.sub || /[\u0000-\u0020]/u.test(payload.sub)) {
    throw new SafeError('AUTH_REQUIRED', 'The platform caller identity is unavailable.');
  }
  const sub = payload.sub;
  if (payload.idtyp === 'fmi' || sub.includes('/users/')) {
    const segments = sub.split('/').filter(Boolean);
    const owner = segments.at(-1);
    if (!owner || owner === 'users' || owner === 'unknown') throw new SafeError('AUTH_REQUIRED', 'The platform caller identity is unavailable.');
    return owner;
  }
  if (sub === 'unknown') throw new SafeError('AUTH_REQUIRED', 'The platform caller identity is unavailable.');
  return sub;
}

export function pilotOwner(token: string, config: DeploymentConfig): string {
  const caller = claims(token);
  if (caller.idtyp === 'fmi') {
    const sub = caller.sub;
    if (typeof caller.tid !== 'string' || !UUID.test(caller.tid) || typeof caller.iss !== 'string' ||
        ![`https://sts.windows.net/${caller.tid.toLowerCase()}/`, `https://login.microsoftonline.com/${caller.tid.toLowerCase()}/v2.0`].includes(caller.iss.toLowerCase()) ||
        typeof sub !== 'string' || sub.length > 1024 || sub.trim() !== sub || /[\u0000-\u0020]/u.test(sub)) {
      throw new SafeError('AUTH_REQUIRED', 'The platform caller identity is unavailable.');
    }
    const match = sub.match(/^\/?eid1\/c\/pub\/t\/[A-Za-z0-9_-]+\/a\/[A-Za-z0-9_-]+\/workspaces\/([^/]+)\/projects\/([^/]+)\/users\/([^/]+)$/);
    if (!match || !UUID.test(match[1]) || !UUID.test(match[2]) || !UUID.test(match[3]) ||
        match[1].toLowerCase() !== config.workspaceId || match[2].toLowerCase() !== config.appId) {
      throw new SafeError('IDENTITY_SCOPE', 'The managed caller context does not match the configured workspace and app.');
    }
    if (match[3].toLowerCase() !== config.ownerId) {
      throw new SafeError('PILOT_ACCESS_DENIED', 'Access is restricted to the configured application owner. Fabric access uses the application owner identity, not viewer permissions.');
    }
    return config.ownerId;
  }
  if (typeof caller.tid !== 'string' || caller.tid.toLowerCase() !== config.tenantId) {
    throw new SafeError('TENANT_SCOPE', 'The caller context does not match the configured tenant.');
  }
  if ((caller.idtyp !== undefined && caller.idtyp !== 'user') ||
      typeof caller.sub !== 'string' || !UUID.test(caller.sub)) {
    throw new SafeError('AUTH_REQUIRED', 'The platform caller identity is unavailable.');
  }
  const owner = callerOwner(token);
  if (owner !== config.ownerId) {
    throw new SafeError('PILOT_ACCESS_DENIED', 'Access is restricted to the configured application owner. Fabric access uses the application owner identity, not viewer permissions.');
  }
  return owner;
}

export function fabricToken(token: string, config: DeploymentConfig): string {
  const payload = claims(token);
  if (typeof payload.tid !== 'string' || payload.tid.toLowerCase() !== config.tenantId ||
      !['https://api.fabric.microsoft.com', 'https://api.fabric.microsoft.com/', '00000009-0000-0000-c000-000000000000'].includes(String(payload.aud))) {
    throw new SafeError('TENANT_SCOPE', 'Fabric access is restricted to the configured tenant and Fabric audience.');
  }
  if (typeof payload.oid !== 'string' || payload.oid.toLowerCase() !== config.ownerId) {
    throw new SafeError('IDENTITY_SCOPE', 'The Fabric resource identity must match the configured application owner.');
  }
  return token;
}

export function storageToken(token: string, owner: string, config: DeploymentConfig): string {
  const payload = claims(token);
  if (typeof payload.tid !== 'string' || payload.tid.toLowerCase() !== config.tenantId ||
      typeof payload.oid !== 'string' || payload.oid.toLowerCase() !== owner ||
      !['https://storage.azure.com', 'https://storage.azure.com/'].includes(String(payload.aud))) {
    throw new SafeError('STORAGE_SCOPE', 'Saved result access requires the approved application owner and Storage audience.');
  }
  return token;
}

export async function safeResult(action: () => Promise<unknown>): Promise<string> {
  try { return JSON.stringify(await action()); }
  catch (error) {
    return JSON.stringify({ error: error instanceof SafeError
      ? { code: error.code, message: error.message, ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }
      : { code: 'SERVICE_UNAVAILABLE', message: 'The operation could not be completed. No automatic retry was performed.' } });
  }
}
