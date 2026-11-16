import type { AgentProbe } from '@rayfin-app/shared';
import { Metadata, type Request } from './metadata.js';
import { fabricToken, object, SafeError, text, uuid, type DeploymentConfig } from './safety.js';

const OFFERED_PROTOCOL_VERSION = '2025-06-18';
// This capability-only wire exchange is supported for these reviewed MCP revisions.
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', OFFERED_PROTOCOL_VERSION]);
type ProbeResult = AgentProbe & {
  protocolDiagnostics: { offeredVersion: string; receivedVersion?: string };
};

function safeProtocolVersion(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}

function rpc(value: unknown, id: number): Record<string, unknown> {
  const body = object(value);
  const method = id === 1 ? 'initialize' : 'tools/list';
  if (body.error !== undefined && body.error !== null) {
    const error = object(body.error);
    const code = typeof error.code === 'number' && Number.isSafeInteger(error.code) ? ` (JSON-RPC code ${error.code})` : '';
    throw new SafeError('MCP_RPC_ERROR', `The agent rejected MCP ${method}${code}. No question was sent.`);
  }
  if (body.jsonrpc !== '2.0' || body.id !== id || !body.result) {
    throw new SafeError('MCP_PROTOCOL_ERROR', 'The agent returned an invalid or unsuccessful MCP response.');
  }
  return object(body.result);
}

function eventValue(event: string): unknown | undefined {
  const lines = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
  if (!lines.length) return undefined;
  return JSON.parse(lines.join('\n'));
}

async function boundedBody(response: Response, id?: number): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const sse = contentType.includes('text/event-stream');
  if (id !== undefined && !sse && !contentType.includes('application/json')) {
    throw new SafeError('MCP_PROTOCOL_ERROR', 'The agent returned an unsupported MCP content type.');
  }
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > 1048576)) {
    throw new SafeError('MCP_RESPONSE_LIMIT', 'The agent capability response exceeded its size limit.');
  }
  if (!response.body) {
    if (id === undefined) return undefined;
    throw new SafeError('MCP_PROTOCOL_ERROR', 'The agent returned an empty MCP response.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1048576) throw new SafeError('MCP_RESPONSE_LIMIT', 'The agent capability response exceeded its size limit.');
      buffer += decoder.decode(part.value, { stream: true });
      if (sse && id !== undefined) {
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const parsed = eventValue(event);
          if (parsed && object(parsed).id === id) return parsed;
        }
      }
    }
    buffer += decoder.decode();
    if (id === undefined) return undefined; // A notification may acknowledge with plain-text Accepted.
    const parsed: unknown = sse ? eventValue(buffer) : JSON.parse(buffer);
    if (!parsed) throw new SafeError('MCP_PROTOCOL_ERROR', 'The agent returned no MCP result.');
    return parsed;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

function schema(value: unknown): Record<string, unknown> {
  const result = object(value);
  if (result.type !== 'object' ||
      (result.properties !== undefined && (!result.properties || typeof result.properties !== 'object' || Array.isArray(result.properties))) ||
      (result.required !== undefined && (!Array.isArray(result.required) || result.required.some(item => typeof item !== 'string')))) {
    throw new SafeError('MCP_SCHEMA_INVALID', 'The agent advertised an invalid tool input schema.');
  }
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 5000 || depth > 16) throw new SafeError('MCP_SCHEMA_INVALID', 'The agent tool schema exceeded safe complexity limits.');
    if (item && typeof item === 'object') for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(result, 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 20000) throw new SafeError('MCP_SCHEMA_INVALID', 'The agent tool schema exceeded its size limit.');
  return result;
}

/** Capability handshake only. No question input, inference or tool execution exists here. */
export async function probeAgent(token: string, workspaceId: string, agentId: string, config: DeploymentConfig, request: Request = fetch): Promise<ProbeResult> {
  const workspace = uuid(workspaceId);
  const agent = uuid(agentId);
  const result: ProbeResult = {
    workspaceId: workspace, agentId: agent, checkedAt: new Date().toISOString(), reachable: false, publishedStage: 'unknown', tools: [],
    protocolDiagnostics: { offeredVersion: OFFERED_PROTOCOL_VERSION },
  };
  const deadline = Date.now() + 30000;
  try {
    const bearer = fabricToken(token, config);
    await new Metadata(bearer, config, request, deadline).agent(workspace, agent);
    const endpoint = `https://api.fabric.microsoft.com/v1/mcp/workspaces/${workspace}/dataagents/${agent}/agent`;
    let session: string | undefined;
    let negotiatedVersion = OFFERED_PROTOCOL_VERSION;
    const post = async (method: 'initialize' | 'notifications/initialized' | 'tools/list', id?: number, params?: Record<string, unknown>): Promise<unknown> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SafeError('MCP_TIMEOUT', 'The agent capability probe exceeded its time budget.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(15000, remaining));
      try {
        const response = await request(endpoint, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: {
            Authorization: `Bearer ${bearer}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
            'MCP-Protocol-Version': negotiatedVersion, 'x-ms-fabric-skill': 'proofbench',
            ...(session ? { 'Mcp-Session-Id': session } : {}),
          },
          body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) }),
        });
        if (!response.ok) throw new SafeError(response.status === 403 ? 'MCP_FORBIDDEN' : response.status === 429 ? 'MCP_THROTTLED' : 'MCP_UNAVAILABLE',
          response.status === 403 ? 'The application owner identity cannot access this agent MCP endpoint.'
            : response.status === 429 ? 'The agent capability endpoint is throttled. Try again later.' : 'The agent capability endpoint is unavailable.');
        const receivedSession = response.headers.get('mcp-session-id');
        if (receivedSession) {
          if (!/^[\x21-\x7e]{1,1024}$/.test(receivedSession)) throw new SafeError('MCP_PROTOCOL_ERROR', 'The agent returned an invalid MCP session identifier.');
          session = receivedSession;
        }
        return await boundedBody(response, id);
      } catch (error) {
        if (error instanceof SafeError) throw error;
        throw new SafeError(controller.signal.aborted ? 'MCP_TIMEOUT' : 'MCP_PROTOCOL_ERROR',
          controller.signal.aborted ? 'The agent capability probe timed out.' : 'The agent returned an invalid or unavailable capability response.');
      } finally { clearTimeout(timer); }
    };
    const initialized = rpc(await post('initialize', 1, {
      protocolVersion: OFFERED_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'proofbench-capability-probe', version: '1.0.0' },
    }), 1);
    const receivedVersion = safeProtocolVersion(initialized.protocolVersion);
    if (receivedVersion) result.protocolDiagnostics.receivedVersion = receivedVersion;
    if (!receivedVersion || !SUPPORTED_PROTOCOL_VERSIONS.has(receivedVersion)) {
      throw new SafeError('MCP_VERSION_UNSUPPORTED',
        `The agent selected an unsupported MCP protocol version. Offered: ${OFFERED_PROTOCOL_VERSION}; received: ${receivedVersion ?? 'missing or invalid'}.`);
    }
    negotiatedVersion = receivedVersion;
    if (!initialized.capabilities || typeof initialized.capabilities !== 'object' || Array.isArray(initialized.capabilities)) {
      throw new SafeError('MCP_PROTOCOL_ERROR', 'The agent returned invalid MCP capabilities.');
    }
    const capabilities = object(initialized.capabilities);
    if (!capabilities.tools || typeof capabilities.tools !== 'object' || Array.isArray(capabilities.tools)) {
      throw new SafeError('MCP_TOOLS_UNAVAILABLE', 'The agent did not advertise the MCP tools capability.');
    }
    await post('notifications/initialized');
    const listed = rpc(await post('tools/list', 2, {}), 2);
    if (!Array.isArray(listed.tools) || listed.tools.length > 100 || listed.nextCursor !== undefined) {
      throw new SafeError('MCP_SCHEMA_INVALID', 'The agent capability list is invalid or exceeds this bounded probe.');
    }
    const names = new Set<string>();
    result.tools = listed.tools.map(value => {
      const tool = object(value);
      const name = text(tool.name, 1, 200);
      if (names.has(name)) throw new SafeError('MCP_SCHEMA_INVALID', 'The agent advertised duplicate tool names.');
      names.add(name);
      return { name, ...(tool.description !== undefined ? { description: text(tool.description, 1, 2000) } : {}), inputSchema: schema(tool.inputSchema) };
    });
    result.reachable = true;
  } catch (error) {
    result.tools = [];
    result.error = error instanceof SafeError ? { code: error.code, message: error.message }
      : { code: 'MCP_UNAVAILABLE', message: 'The agent capability probe could not be completed.' };
  }
  result.checkedAt = new Date().toISOString();
  return result;
}
