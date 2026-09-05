import assert from 'node:assert/strict';
import test from 'node:test';
import { projectMcpServers, projectSubagents, validateHttpsUrl, validateIntegrations } from '../src/integrations.ts';
import { parseProfile, ProfileError } from '../src/profile.ts';

const inactive = { disabled: true, approveTools: true };

test('projects selected MCP commands inactive with environment names, never values', () => {
  const projected = projectMcpServers({ example: { command: 'npx', args: ['-y', 'example-server@1.2.3'], disabled: false, approveTools: false, env: { EXAMPLE_KEY: 'synthetic-secret' }, headers: { Authorization: 'synthetic-secret' }, cwd: '/synthetic/private', requestHeadersCommand: { command: 'not-executed' } } });
  assert.deepEqual(projected.value, { example: { ...inactive, command: 'npx', args: ['-y', 'example-server@1.2.3'], envNames: ['EXAMPLE_KEY'] } });
  assert.equal(projected.diagnostics.length, 3);
  assert.equal(JSON.stringify(projected).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(projected).includes('/synthetic/private'), false);
  assert.deepEqual(validateIntegrations({ mcpServers: projected.value }).mcpServers, projected.value);
});

test('rejects imported connection or approval activation and unknown fields', () => {
  for (const config of [{ command: 'node' }, { ...inactive, command: 'node', disabled: false }, { ...inactive, command: 'node', approveTools: false }, { ...inactive, command: 'node', env: {} }, { ...inactive, command: 'node', url: 'https://example.com/mcp' }, { ...inactive, url: 'https://example.com/mcp', args: [] }]) {
    assert.throws(() => validateIntegrations({ mcpServers: { example: config } }), ProfileError);
  }
});

test('filters direct IPs, reserved hosts, credentials, non-HTTPS and URL parameters without DNS', () => {
  assert.equal(validateHttpsUrl('https://example.com/mcp', 'url'), 'https://example.com/mcp');
  for (const url of ['http://example.com', 'https://localhost', 'https://x.local', 'https://x.internal', 'https://x.home.arpa', 'https://127.1', 'https://0x7f000001', 'https://[::1]', 'https://user:pass@example.com', 'https://example.com/?key=secret', 'https://example.com/#secret', 'https://example.com/?', 'https://example.com/#', 'https://example.com/\\\\ambiguous', 'https://example.com:8443', 'https://oneword']) {
    assert.throws(() => validateHttpsUrl(url, 'url'), ProfileError);
  }
});

test('omits nonportable commands, secret-like arguments and unsupported sockets', () => {
  for (const server of [{ command: '/usr/bin/node' }, { command: 'node', args: ['--api-key=synthetic-secret'] }, { command: 'node', args: ['C:\\synthetic\\file'] }, { command: 'node', args: ['--file=/synthetic/file'] }, { command: 'node', args: ['\\\\synthetic\\share'] }, { command: 'node', args: ['https://example.com/?secret=value'] }, { socket: '/synthetic/socket' }]) {
    const projected = projectMcpServers({ example: server });
    assert.deepEqual(projected.value, {});
    assert.ok(projected.diagnostics.length > 0);
    assert.equal(JSON.stringify(projected).includes('synthetic-secret'), false);
  }
});

test('preserves explicit empty tools filters and copies arrays', () => {
  const input = { example: { ...inactive, url: 'https://example.com/mcp', envNames: [], includeTools: [], excludeTools: ['write_*'], requestTimeoutMs: 5000 } };
  const output = validateIntegrations({ mcpServers: input });
  assert.deepEqual(output.mcpServers, input);
  input.example.excludeTools.push('read_*');
  assert.deepEqual(output.mcpServers?.example?.excludeTools, ['write_*']);
  for (const requestTimeoutMs of [0, -1, Infinity, 600001, 1.5]) {
    assert.throws(() => validateIntegrations({ mcpServers: { example: { ...inactive, command: 'node', requestTimeoutMs } } }), ProfileError);
  }
});

test('rejects excess cardinality, unsafe names and getters without invocation', () => {
  assert.throws(() => validateIntegrations({ mcpServers: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`s${index}`, { ...inactive, command: 'node' }])) }), ProfileError);
  assert.throws(() => validateIntegrations({ mcpServers: JSON.parse('{"__proto__":{"disabled":true,"approveTools":true,"command":"node"}}') }), ProfileError);
  let calls = 0;
  const input = Object.defineProperty({}, 'command', { enumerable: true, get() { calls++; return 'node'; } });
  assert.deepEqual(projectMcpServers({ example: input }).value, {});
  assert.equal(calls, 0);
});

test('projects only minimal subagent settings, not operational configuration or overrides', () => {
  const result = projectSubagents({ defaultModel: 'example/model:free', defaultThinking: 'high', disableThinking: false, disableBuiltins: true, agentOverrides: { worker: { tools: ['bash'] } }, defaultExtensions: ['/synthetic/private'], modelScope: { mode: 'unrestricted' } });
  assert.deepEqual(result.value, { defaultModel: 'example/model:free', defaultThinking: 'high', disableThinking: false, disableBuiltins: true });
  assert.equal(result.diagnostics.length, 3);
  assert.equal(JSON.stringify(result).includes('/synthetic/private'), false);
  assert.deepEqual(validateIntegrations({ subagents: result.value }).subagents, result.value);
  assert.throws(() => validateIntegrations({ subagents: { agentOverrides: {} } }), ProfileError);
  assert.throws(() => validateIntegrations({ subagents: { defaultThinking: 'turbo' } }), ProfileError);
});

test('preserves portable mixed-case environment names without values', () => {
  assert.throws(() => validateIntegrations({ mcpServers: { example: { ...inactive, command: 'node', envNames: ['Path', 'PATH'] } } }), ProfileError);
  assert.deepEqual(projectMcpServers({ example: { command: 'node', env: { Path: 'synthetic-secret', npm_config_registry: 'synthetic-secret' } } }).value, { example: { ...inactive, command: 'node', envNames: ['Path', 'npm_config_registry'] } });
});

test('rejects empty URL userinfo, including Git-consumed URL validation', () => {
  for (const url of ['https://@example.com/mcp', 'https://:@example.com/mcp']) {
    assert.throws(() => validateHttpsUrl(url, 'url'), ProfileError);
  }
});

test('rejects colon-delimited and quoted absolute argument paths', () => {
  for (const arg of ['--path:C:/synthetic/file', '--path:\\\\synthetic\\share', '--path="C:/synthetic/file"', '-I/usr/include', '-I~/include', '-I~\\include', '-I"~/include"']) {
    assert.deepEqual(projectMcpServers({ example: { command: 'node', args: [arg] } }).value, {});
  }
});

test('profile integration envelope preserves absent and empty fields', () => {
  const profile = { format: 'pi-setup-share', version: 1, resources: [] };
  assert.deepEqual(parseProfile(JSON.stringify(profile)), profile);
  assert.deepEqual(parseProfile(JSON.stringify({ ...profile, integrations: { mcpServers: {}, subagents: {} } })).integrations, { mcpServers: {}, subagents: {} });
  assert.throws(() => parseProfile(JSON.stringify({ ...profile, integrations: { unknown: {} } })), ProfileError);
});
