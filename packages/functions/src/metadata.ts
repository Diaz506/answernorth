import type { Agent, Workspace } from '@rayfin-app/shared';
import { fabricToken, object, SafeError, text, uuid, type DeploymentConfig } from './safety.js';

const BASE = 'https://api.fabric.microsoft.com/v1';
export type Request = typeof fetch;

/** Per invocation only: a fixed Fabric origin and one shared 30-second budget. */
export class Metadata {
  private readonly token: string;
  constructor(token: string, config: DeploymentConfig, private readonly request: Request = fetch, private readonly deadline = Date.now() + 30000) {
    this.token = fabricToken(token, config);
  }

  private async get(path: string, continuation?: string): Promise<Record<string, unknown>> {
    if (!/^\/workspaces(?:\/[0-9a-f-]{36}(?:\/items(?:\/[0-9a-f-]{36})?)?)?$/.test(path)) {
      throw new SafeError('INVALID_SCOPE', 'The metadata request is outside the approved scope.');
    }
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new SafeError('METADATA_TIMEOUT', 'Fabric metadata discovery exceeded its time budget.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(15000, remaining));
    try {
      const url = new URL(BASE + path);
      if (continuation) url.searchParams.set('continuationToken', continuation);
      const response = await this.request(url.toString(), {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', 'x-ms-fabric-skill': 'proofbench' },
      });
      if (!response.ok) {
        const code = response.status === 403 ? 'FABRIC_FORBIDDEN' : response.status === 429 ? 'FABRIC_THROTTLED' : 'FABRIC_METADATA_FAILED';
        throw new SafeError(code, response.status === 403
          ? 'The application identity does not have permission to read this Fabric metadata.'
          : response.status === 429 ? 'Fabric metadata requests are throttled. Try again later.'
          : 'Fabric metadata could not be retrieved.');
      }
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > 1048576)) {
        throw new SafeError('METADATA_TOO_LARGE', 'Fabric metadata exceeded the response-size limit.');
      }
      if (!response.body) throw new SafeError('INVALID_METADATA', 'Fabric returned an invalid metadata response.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1048576) {
            await reader.cancel();
            throw new SafeError('METADATA_TOO_LARGE', 'Fabric metadata exceeded the response-size limit.');
          }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError(controller.signal.aborted ? 'METADATA_TIMEOUT' : 'FABRIC_METADATA_FAILED',
        controller.signal.aborted ? 'Fabric metadata discovery timed out.' : 'Fabric returned unavailable or invalid metadata.');
    } finally { clearTimeout(timer); }
  }

  async workspace(id: string): Promise<Workspace> {
    const verifiedId = uuid(id);
    const row = await this.get(`/workspaces/${verifiedId}`);
    if (uuid(row.id) !== verifiedId) throw new SafeError('INVALID_SCOPE', 'Fabric returned metadata for a different workspace.');
    return { id: verifiedId, name: text(row.displayName, 1, 256) };
  }

  async agent(workspaceId: string, agentId: string): Promise<Agent> {
    const workspace = await this.workspace(uuid(workspaceId));
    const id = uuid(agentId);
    const row = await this.get(`/workspaces/${workspace.id}/items/${id}`);
    if (uuid(row.id) !== id || row.type !== 'DataAgent' ||
        (row.workspaceId !== undefined && uuid(row.workspaceId) !== workspace.id)) {
      throw new SafeError('INVALID_AGENT', 'The requested item is not a verified DataAgent in the selected workspace.');
    }
    return { id, name: text(row.displayName, 1, 256), workspaceId: workspace.id, workspaceName: workspace.name };
  }

  private async list(path: string, limit: number): Promise<{ rows: Record<string, unknown>[]; complete: boolean }> {
    const rows: Record<string, unknown>[] = [];
    const tokens = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 10; page++) {
      const body = await this.get(path, token);
      if (!Array.isArray(body.value)) throw new SafeError('INVALID_METADATA', 'Fabric returned an invalid metadata list.');
      for (const value of body.value) {
        if (rows.length >= limit) return { rows, complete: false };
        rows.push(object(value));
      }
      if (body.continuationToken === undefined || body.continuationToken === null || body.continuationToken === '') {
        return { rows, complete: true };
      }
      if (typeof body.continuationToken !== 'string' || body.continuationToken.length > 8192 || tokens.has(body.continuationToken)) {
        throw new SafeError('INVALID_METADATA', 'Fabric returned invalid pagination metadata.');
      }
      token = body.continuationToken;
      tokens.add(token);
      if (rows.length >= limit) return { rows, complete: false };
    }
    return { rows, complete: false };
  }

  async workspaces(): Promise<{ workspaces: Workspace[]; complete: boolean }> {
    const result = await this.list('/workspaces', 500);
    const seen = new Set<string>();
    const workspaces = result.rows.map(row => {
      const id = uuid(row.id);
      if (seen.has(id)) throw new SafeError('INVALID_METADATA', 'Fabric returned duplicate workspace metadata.');
      seen.add(id);
      return { id, name: text(row.displayName, 1, 256) };
    });
    return { workspaces, complete: result.complete };
  }

  async agents(workspaceId: string): Promise<{ agents: Agent[]; complete: boolean; checkedAt: string }> {
    const workspace = await this.workspace(workspaceId);
    const result = await this.list(`/workspaces/${workspace.id}/items`, 1000);
    const agents: Agent[] = [];
    const seen = new Set<string>();
    for (const row of result.rows) {
      const id = uuid(row.id);
      if (row.workspaceId !== undefined && uuid(row.workspaceId) !== workspace.id) {
        throw new SafeError('INVALID_SCOPE', 'Fabric returned an item outside the requested workspace.');
      }
      if (typeof row.type !== 'string') throw new SafeError('INVALID_METADATA', 'Fabric returned an item without its type.');
      if (seen.has(id)) throw new SafeError('INVALID_METADATA', 'Fabric returned duplicate item metadata.');
      seen.add(id);
      if (row.type === 'DataAgent') agents.push({
        id, name: text(row.displayName, 1, 256), workspaceId: workspace.id, workspaceName: workspace.name,
      });
    }
    return { agents, complete: result.complete, checkedAt: new Date().toISOString() };
  }
}
