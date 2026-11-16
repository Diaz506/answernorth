import test from 'node:test';
import assert from 'node:assert/strict';
import { probeAgent as probeWithConfig } from '../dist/probe.js';
import { backend } from '../dist/backend.js';
import { deploymentConfig } from '../dist/safety.js';


// Fictional test-only UUIDs; not resource identifiers.
const TENANT_ID = 'a0a00001-1234-4abc-8def-000000000001';
const OWNER_ID = 'a0a00002-1234-4abc-8def-000000000002';
const APP_WORKSPACE_ID = 'a0a00003-1234-4abc-8def-000000000003';
const APP_ID = 'a0a00006-1234-4abc-8def-000000000006';
Object.assign(process.env, { ANSWERNORTH_TENANT_ID: TENANT_ID, ANSWERNORTH_OWNER_ID: OWNER_ID, ANSWERNORTH_WORKSPACE_ID: APP_WORKSPACE_ID, ANSWERNORTH_APP_ID: APP_ID });
const getSecret = name => process.env[name];
const probeAgent = (token, workspace, agent, request) =>
  probeWithConfig(token, workspace, agent, deploymentConfig({ getSecret }), request);
const WORKSPACE = 'a0a00004-1234-4abc-8def-000000000004';
const AGENT = 'a0a00005-1234-4abc-8def-000000000005';
const token = claims => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString('base64url')}.signature`;
const fabric = claims => token({ tid: TENANT_ID, oid: OWNER_ID, aud: 'https://api.fabric.microsoft.com', ...claims });
const tool = { name: 'advertised_query', description: 'Advertised capability only', inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } };
const json = (body, options = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...options.headers }, status: options.status ?? 200 });

function fixture({ sse = false, session = false, wrongType = false, wrongAgent = false, schema = tool.inputSchema, fail = 0,
  protocolVersion = '2025-06-18', capabilities = { tools: {} } } = {}) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return json({ id: WORKSPACE, displayName: 'Verified workspace' });
    if (calls.length === 2) return json({ id: wrongAgent ? WORKSPACE : AGENT, displayName: 'Verified agent', type: wrongType ? 'Report' : 'DataAgent', workspaceId: WORKSPACE });
    if (fail) return json({ secret: 'raw provider credentials must not escape' }, { status: fail });
    const body = JSON.parse(options.body);
    if (body.method === 'notifications/initialized') return new Response('Accepted', { status: 202 });
    const result = body.method === 'initialize'
      ? { protocolVersion, capabilities, serverInfo: { name: 'agent', version: '1' } }
      : { tools: [{ ...tool, inputSchema: schema }] };
    const rpc = { jsonrpc: '2.0', id: body.id, result };
    const headers = session ? { 'mcp-session-id': 'bounded-test-session' } : {};
    return sse
      ? new Response(`event: message\r\ndata: ${JSON.stringify(rpc)}\r\n\r\n`, { headers: { 'content-type': 'text/event-stream', ...headers } })
      : json(rpc, { headers });
  };
  return { calls, request };
}

test('supported older MCP revision is negotiated and used on subsequent requests', async () => {
  for (const sse of [false, true]) {
    const { request, calls } = fixture({ sse, session: true, protocolVersion: '2024-11-05' });
    const result = await probeAgent(fabric(), WORKSPACE, AGENT, request);
    assert.equal(result.reachable, true);
    assert.deepEqual(result.protocolDiagnostics, { offeredVersion: '2025-06-18', receivedVersion: '2024-11-05' });
    const posts = calls.filter(call => call.options.method === 'POST');
    assert.equal(JSON.parse(posts[0].options.body).params.protocolVersion, '2025-06-18');
    assert.deepEqual(posts.map(call => call.options.headers['MCP-Protocol-Version']), ['2025-06-18', '2024-11-05', '2024-11-05']);
    assert.deepEqual(posts.map(call => JSON.parse(call.options.body).method), ['initialize', 'notifications/initialized', 'tools/list']);
    assert.ok(posts.every(call => !call.options.body.includes('tools/call')));
  }
});

test('unsupported dated MCP revision is safely diagnosed and stops before notification/tools', async () => {
  for (const protocolVersion of ['2025-01-01', '2099-01-01']) {
    const { request, calls } = fixture({ protocolVersion });
    const result = await probeAgent(fabric(), WORKSPACE, AGENT, request);
    assert.equal(result.reachable, false);
    assert.equal(result.error.code, 'MCP_VERSION_UNSUPPORTED');
    assert.deepEqual(result.protocolDiagnostics, { offeredVersion: '2025-06-18', receivedVersion: protocolVersion });
    assert.ok(result.error.message.includes(protocolVersion));
    assert.equal(calls.length, 3);
    assert.deepEqual(result.tools, []);
  }
});

test('malformed MCP version diagnostics cannot expose arbitrary server text or objects', async () => {
  for (const protocolVersion of [null, {}, 20250326, '2025-02-30', '2025-99-99', '2024-11-05\nBearer private-token', 'provider private question']) {
    const { request, calls } = fixture({ protocolVersion });
    const result = await probeAgent(fabric(), WORKSPACE, AGENT, request);
    assert.equal(result.error.code, 'MCP_VERSION_UNSUPPORTED');
    assert.deepEqual(result.protocolDiagnostics, { offeredVersion: '2025-06-18' });
    assert.ok(result.error.message.includes('missing or invalid'));
    assert.ok(!JSON.stringify(result).includes('private'));
    assert.equal(calls.length, 3);
  }
});

test('Current protocol revision and the previous revision complete capability-only discovery', async () => {
  for (const protocolVersion of ['2025-06-18', '2025-03-26']) {
    for (const sse of [false, true]) {
      const { request, calls } = fixture({ protocolVersion, sse, session: true });
      const result = await probeAgent(fabric(), WORKSPACE, AGENT, request);
      assert.equal(result.reachable, true);
      assert.equal(result.protocolDiagnostics.receivedVersion, protocolVersion);
      const posts = calls.filter(call => call.options.method === 'POST');
      assert.deepEqual(posts.map(call => JSON.parse(call.options.body).method),
        ['initialize', 'notifications/initialized', 'tools/list']);
      assert.equal(posts[1].options.headers['MCP-Protocol-Version'], protocolVersion);
      assert.equal(posts[2].options.headers['MCP-Protocol-Version'], protocolVersion);
    }
  }
});

test('missing tools capability is distinguished from version negotiation failure', async () => {
  const { request, calls } = fixture({ protocolVersion: '2024-11-05', capabilities: {} });
  const result = await probeAgent(fabric(), WORKSPACE, AGENT, request);
  assert.equal(result.error.code, 'MCP_TOOLS_UNAVAILABLE');
  assert.equal(result.protocolDiagnostics.receivedVersion, '2024-11-05');
  assert.equal(calls.length, 3);
});

test('null error fields do not invalidate successful capability responses', async () => {
  const f = fixture();
  const request = async (url, options) => {
    const response = await f.request(url, options);
    if (options.method !== 'POST' || JSON.parse(options.body).method === 'notifications/initialized') return response;
    const body = await response.json();
    return json({ ...body, error: null });
  };
  const result = await probeAgent(fabric(), WORKSPACE, AGENT, request);
  assert.equal(result.reachable, true);
});

test('tools-list JSON-RPC errors expose only a bounded numeric code, not provider text', async () => {
  const f = fixture();
  const request = async (url, options) => {
    const response = await f.request(url, options);
    if (options.method === 'POST' && JSON.parse(options.body).method === 'tools/list') {
      return json({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'private raw provider text', data: 'secret' } });
    }
    return response;
  };
  const result = await probeAgent(fabric(), WORKSPACE, AGENT, request);
  assert.equal(result.reachable, false);
  assert.equal(result.error.code, 'MCP_RPC_ERROR');
  assert.match(result.error.message, /tools\/list.*-32602/);
  assert.doesNotMatch(JSON.stringify(result), /private|secret/);
});

for (const sse of [false, true]) for (const session of [false, true]) {
  test(`probe supports ${sse ? 'SSE' : 'JSON'} and ${session ? 'optional session' : 'no session'}, and never executes tools`, async () => {
    const { request, calls } = fixture({ sse, session });
    const result = await probeAgent(fabric(), WORKSPACE, AGENT, request);
    assert.equal(result.reachable, true);
    assert.equal(result.publishedStage, 'unknown');
    assert.deepEqual(result.tools, [tool]);
    assert.equal(result.error, undefined);
    assert.equal(calls.length, 5);
    const posts = calls.filter(call => call.options.method === 'POST');
    assert.deepEqual(posts.map(call => JSON.parse(call.options.body).method), ['initialize', 'notifications/initialized', 'tools/list']);
    for (const call of posts) {
      assert.equal(call.url, `https://api.fabric.microsoft.com/v1/mcp/workspaces/${WORKSPACE}/dataagents/${AGENT}/agent`);
      assert.equal(call.options.redirect, 'error');
      assert.equal(call.options.headers['x-ms-fabric-skill'], 'proofbench');
      assert.ok(!call.options.body.includes('tools/call'));
      assert.ok(!('question' in (JSON.parse(call.options.body).params ?? {})));
    }
    assert.equal(posts[1].options.headers['Mcp-Session-Id'], session ? 'bounded-test-session' : undefined);
  });
}

test('probe rejects wrong agent metadata/type before contacting MCP', async () => {
  for (const options of [{ wrongAgent: true }, { wrongType: true }]) {
    const { request, calls } = fixture(options);
    const result = await probeAgent(fabric(), WORKSPACE, AGENT, request);
    assert.equal(result.reachable, false);
    assert.equal(result.error.code, 'INVALID_AGENT');
    assert.equal(calls.length, 2);
  }
});

test('probe rejects malformed identifiers and wrong-tenant native token without outbound access', async () => {
  let calls = 0;
  const request = async () => { calls++; throw new Error('must never be called'); };
  await assert.rejects(() => probeAgent(fabric(), WORKSPACE, '../agent', request));
  const result = await probeAgent(fabric({ tid: WORKSPACE }), WORKSPACE, AGENT, request);
  assert.equal(result.error.code, 'TENANT_SCOPE');
  assert.equal(result.reachable, false);
  assert.equal(calls, 0);
});

test('wrong tool input schema is rejected without a tool call', async () => {
  for (const schema of [null, [], { type: 'string' }, { type: 'object', properties: [] }, { type: 'object', required: [1] }]) {
    const { request, calls } = fixture({ schema });
    const result = await probeAgent(fabric(), WORKSPACE, AGENT, request);
    assert.equal(result.reachable, false);
    assert.ok(result.error);
    assert.deepEqual(result.tools, []);
    assert.equal(calls.length, 5);
  }
});

test('probe 403/429 are explicit and raw provider body never escapes', async () => {
  for (const [fail, code] of [[403, 'MCP_FORBIDDEN'], [429, 'MCP_THROTTLED']]) {
    const { request, calls } = fixture({ fail });
    const result = await probeAgent(fabric(), WORKSPACE, AGENT, request);
    assert.equal(result.error.code, code);
    assert.equal(result.reachable, false);
    assert.deepEqual(result.tools, []);
    assert.ok(!JSON.stringify(result).includes('credentials'));
    assert.equal(calls.length, 3);
  }
});

test('probe pilot owner fence rejects nonowner before any metadata call', async () => {
  let calls = 0;
  const request = async () => { calls++; throw new Error('must not call'); };
  for (const owner of ['other', `${OWNER_ID}-spoof`]) {
    const ctx = { accessToken: token({ sub: owner, tid: TENANT_ID }), Tokens: { Fabric: fabric() }, getSecret };
    const result = JSON.parse(await backend(ctx, { request }).probeAgent(WORKSPACE, AGENT));
    assert.equal(result.error.code, 'AUTH_REQUIRED');
  }
  assert.equal(calls, 0);
});

test('probe bounds MCP bodies and stops after invalid JSON-RPC results', async () => {
  for (const body of [
    new Response('x'.repeat(1048577), { headers: { 'content-type': 'application/json' } }),
    json({ jsonrpc: '2.0', id: 999, result: {} }),
    json({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'provider secret' } }),
  ]) {
    const base = fixture();
    const result = await probeAgent(fabric(), WORKSPACE, AGENT, async (url, options) => {
      if (options.method === 'POST') return body;
      return base.request(url, options);
    });
    assert.equal(result.reachable, false);
    assert.ok(result.error);
    assert.ok(!JSON.stringify(result).includes('provider secret'));
  }
});
