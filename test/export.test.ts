import assert from 'node:assert/strict';
import test from 'node:test';
import { exportProfile, serializeProfile } from '../src/export.ts';
import { parseProfile, PROFILE_LIMITS, ProfileError } from '../src/profile.ts';

const resource = { kind: 'extension', path: 'example/index.ts', encoding: 'utf8', content: 'export default function () {}' };

test('composes only explicit selections and preserves empty objects', () => {
  assert.deepEqual(exportProfile({}).profile, { format: 'pi-setup-share', version: 1, resources: [] });
  const result = exportProfile({ preferences: { theme: 'light', shellPath: 'synthetic-secret' }, keybindings: {}, mcpServers: { example: { command: 'node', env: { EXAMPLE_KEY: 'synthetic-secret' } } }, subagents: {}, packages: ['npm:example-tools@1.2.3'] });
  assert.deepEqual(parseProfile(result.text), result.profile);
  assert.equal(result.text.includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(result.diagnostics).includes('synthetic-secret'), false);
  assert.deepEqual(result.profile.keybindings, {});
  assert.deepEqual(result.profile.integrations?.subagents, {});
});

test('never infers executable entrypoints from selected support files', () => {
  const result = exportProfile({ resources: [resource] });
  assert.equal(Object.hasOwn(result.profile, 'entrypoints'), false);
  const explicit = exportProfile({ resources: [resource], entrypoints: { extension: [resource.path] } });
  assert.deepEqual(explicit.profile.entrypoints, { extension: [resource.path] });
});

test('rejects entrypoints missing their selected resource, duplicated or of the wrong type', () => {
  for (const entrypoints of [{ extension: ['missing.ts'] }, { extension: [resource.path, resource.path] }, { prompt: [resource.path] }, { unknown: [] }, { extension: ['../escape.ts'] }]) {
    assert.throws(() => exportProfile({ resources: [resource], entrypoints }), ProfileError);
  }
  assert.throws(() => exportProfile({ resources: [{ ...resource, encoding: 'base64', content: 'eA==' }], entrypoints: { extension: [resource.path] } }), ProfileError);
});

test('allows explicit skill, prompt, theme and agent text entrypoints, but not chains', () => {
  const cases = [{ kind: 'skill', path: 'example/SKILL.md' }, { kind: 'prompt', path: 'example.md' }, { kind: 'theme', path: 'example.json' }, { kind: 'agent', path: 'example.md' }];
  for (const entry of cases) {
    assert.doesNotThrow(() => exportProfile({ resources: [{ ...entry, encoding: 'utf8', content: 'synthetic' }], entrypoints: { [entry.kind]: [entry.path] } }));
  }
  assert.throws(() => exportProfile({ resources: [{ kind: 'agent', path: 'example.chain.md', encoding: 'utf8', content: 'synthetic' }], entrypoints: { agent: ['example.chain.md'] } }), ProfileError);
});

test('bounds serialized output before composing the oversized JSON string', t => {
  const resources = Array.from({ length: 3 }, (_, index) => ({ kind: 'prompt', path: `${index}.md`, encoding: 'utf8', content: '\0'.repeat(PROFILE_LIMITS.fileBytes) }));
  const original = JSON.stringify;
  let calls = 0;
  t.mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => { calls++; return Reflect.apply(original, JSON, args); });
  assert.throws(() => serializeProfile({ format: 'pi-setup-share', version: 1, resources }), ProfileError);
  t.mock.restoreAll();
  assert.equal(calls, 0);
});

test('rejects malformed selections and accessors without evaluation', () => {
  assert.throws(() => exportProfile({ resources: null }), ProfileError);
  assert.throws(() => exportProfile({ unknown: 'synthetic-secret' }), ProfileError);
  let calls = 0;
  const input = Object.defineProperty({}, 'preferences', { enumerable: true, get() { calls++; return {}; } });
  assert.throws(() => exportProfile(input), ProfileError);
  assert.equal(calls, 0);
});
