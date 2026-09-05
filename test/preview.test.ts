import assert from 'node:assert/strict';
import test from 'node:test';
import { previewConfiguration } from '../src/preview.ts';
import { ProfileError } from '../src/profile.ts';

const base = { format: 'pi-setup-share', version: 1, resources: [] };

test('preserves conflicts by default and plans new selected fields only', () => {
  const target = { settings: { theme: 'dark', localOnly: { value: 'synthetic-secret' } } };
  const result = previewConfiguration({ ...base, preferences: { theme: 'light', hideThinkingBlock: false } }, target);
  assert.deepEqual(result.configuration.settings, { theme: 'dark', hideThinkingBlock: false, localOnly: { value: 'synthetic-secret' } });
  assert.deepEqual(result.items, [{ id: 'preferences.theme', status: 'conflict', action: 'preserve' }, { id: 'preferences.hideThinkingBlock', status: 'new', action: 'write' }]);
  assert.equal(JSON.stringify(result.items).includes('synthetic-secret'), false);
  assert.equal(Object.hasOwn(target.settings, 'hideThinkingBlock'), false);
});

test('requires explicit overwrite and evaluates every leaf against the original target', () => {
  const profile = { ...base, preferences: { compaction: { enabled: true, reserveTokens: 10 } } };
  const result = previewConfiguration(profile, { settings: { compaction: false } }, { 'preferences.compaction.enabled': 'overwrite' });
  assert.deepEqual(result.configuration.settings.compaction, { enabled: true });
  assert.deepEqual(result.items.map(item => item.status), ['conflict', 'conflict']);
  assert.equal(result.items[1]?.action, 'preserve');
  assert.throws(() => previewConfiguration(profile, {}, { unknown: 'overwrite' }), ProfileError);
  assert.throws(() => previewConfiguration(profile, {}, { 'preferences.compaction.enabled': 'silent-overwrite' }), ProfileError);
});

test('preserves host keybindings and explicit empty imported bindings', () => {
  const result = previewConfiguration({ ...base, keybindings: { 'app.clear': [] } }, { keybindings: { 'app.clear': 'ctrl+c', 'custom.action': 'ctrl+x' } }, { 'keybindings.app.clear': 'overwrite' });
  assert.deepEqual(result.configuration.keybindings, { 'app.clear': [], 'custom.action': 'ctrl+x' });
});

test('creates inactive MCP placeholders without reading or retaining source credentials', () => {
  const profile = { ...base, integrations: { mcpServers: { example: { disabled: true, approveTools: true, command: 'node', envNames: ['EXAMPLE_KEY'] } } } };
  const target = { mcp: { settings: { localOnly: true }, mcpServers: { example: { command: 'old', env: { EXAMPLE_KEY: 'synthetic-secret' } } } } };
  const result = previewConfiguration(profile, target, { 'mcpServers.example': 'overwrite' });
  assert.deepEqual(result.configuration.mcp, { settings: { localOnly: true }, mcpServers: { example: { disabled: true, approveTools: true, command: 'node', env: { EXAMPLE_KEY: '${EXAMPLE_KEY}' } } } });
  assert.equal(JSON.stringify(result.configuration.mcp).includes('synthetic-secret'), false);
  assert.equal(target.mcp.mcpServers.example.env.EXAMPLE_KEY, 'synthetic-secret');
});

test('does not install packages, activate entries, or invent empty setting writes', () => {
  const result = previewConfiguration({ ...base, packages: [{ source: 'npm:example-tools@1.2.3' }], entrypoints: {}, preferences: {} });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.configuration, { settings: {}, keybindings: {}, mcp: {} });
});

test('rejects invalid and executable target shapes without invoking getters', () => {
  assert.throws(() => previewConfiguration(base, { settings: null }), ProfileError);
  let calls = 0;
  const nested = Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; return 'synthetic-secret'; } });
  assert.throws(() => previewConfiguration(base, { settings: { nested } }), ProfileError);
  assert.equal(calls, 0);
  let depth: unknown = {};
  for (let index = 0; index < 40; index++) depth = { nested: depth };
  assert.throws(() => previewConfiguration(base, { settings: { depth } }), ProfileError);
});
