import assert from 'node:assert/strict';
import test from 'node:test';
import { projectPreferences, validatePreferences } from '../src/preferences.ts';
import { parseProfile, ProfileError, validateProfile } from '../src/profile.ts';

const profile = (preferences: unknown) => ({ format: 'pi-setup-share', version: 1, resources: [], preferences });

test('preserves absent preferences, explicit empty objects and false/zero values', () => {
  assert.equal(Object.hasOwn(validateProfile({ format: 'pi-setup-share', version: 1, resources: [] }), 'preferences'), false);
  assert.deepEqual(parseProfile(JSON.stringify(profile({}))).preferences, {});
  const value = { quietStartup: false, editorPaddingX: 0, compaction: { enabled: false, reserveTokens: 0 } };
  assert.deepEqual(parseProfile(JSON.stringify(profile(value))).preferences, value);
});

test('projects only allowed fields without leaking unknown names or values', () => {
  const selected = JSON.parse('{"quietStartup":true,"synthetic-private-key":"synthetic-secret","terminal":{"showImages":false,"headers":"synthetic-secret"},"__proto__":{"polluted":true}}');
  const result = projectPreferences(selected);
  assert.deepEqual(result.value, { quietStartup: true, terminal: { showImages: false } });
  assert.equal(result.diagnostics.length, 3);
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
  assert.equal(JSON.stringify(result).includes('polluted'), false);
});

test('never projects execution, trust, network, identity or operational settings', () => {
  const excluded = ['externalEditor', 'shellPath', 'shellCommandPrefix', 'npmCommand', 'packages', 'extensions', 'skills', 'prompts', 'themes', 'sessionDir', 'httpProxy', 'transport', 'httpIdleTimeoutMs', 'websocketConnectTimeoutMs', 'enableAnalytics', 'trackingId', 'enableInstallTelemetry', 'defaultProjectTrust', 'defaultTools', 'enabledModels', 'thinkingBudgets', 'lastChangelogVersion', 'modelThinkingLevels'];
  for (const key of excluded) {
    assert.deepEqual(projectPreferences({ [key]: 'synthetic-secret' }).value, {});
    assert.throws(() => parseProfile(JSON.stringify(profile({ [key]: 'synthetic-secret' }))), ProfileError);
  }
});

test('strict import rejects unknown fields at every supported depth', () => {
  for (const value of [{ constructor: false }, { terminal: { images: 'kitty' } }, { compaction: { extra: true } }]) {
    assert.throws(() => parseProfile(JSON.stringify(profile(value))), ProfileError);
  }
});

test('bounds integers and rejects coercion and non-finite numbers', () => {
  for (const [key, min, max] of [['editorPaddingX', 0, 3], ['outputPad', 0, 1], ['autocompleteMaxVisible', 3, 20]] as const) {
    for (const value of [min, max]) assert.deepEqual(validatePreferences({ [key]: value }), { [key]: value });
    for (const value of [min - 1, max + 1, 1.5, '3', NaN, Infinity, null]) {
      assert.throws(() => validatePreferences({ [key]: value }), ProfileError);
    }
  }
  for (const value of [-1, 1.5, 1_000_001, Infinity]) {
    assert.throws(() => validatePreferences({ compaction: { reserveTokens: value } }), ProfileError);
  }
});

test('supports exact thinking enums and bounded identifiers, not arbitrary strings', () => {
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(validatePreferences({ defaultThinkingLevel: level }), { defaultThinkingLevel: level });
  }
  assert.deepEqual(validatePreferences({ defaultProvider: 'example-provider', defaultModel: 'example/model-1' }), { defaultProvider: 'example-provider', defaultModel: 'example/model-1' });
  for (const value of ['', 'a'.repeat(257), 'https://example.invalid', 'x\n', 'x secret']) {
    assert.throws(() => validatePreferences({ defaultModel: value }), ProfileError);
  }
});

test('supports colon-qualified model IDs and stable TUI mode', () => {
  assert.deepEqual(validatePreferences({ defaultModel: 'example/model:free', tuiMode: 'regular' }), { defaultModel: 'example/model:free', tuiMode: 'regular' });
  assert.deepEqual(projectPreferences({ tuiMode: 'regular' }).value, { tuiMode: 'regular' });
  assert.throws(() => validatePreferences({ tuiMode: 'fullscreen' }), ProfileError);
});

test('custom themes and unsupported values are omitted on projection but rejected on import', () => {
  assert.deepEqual(projectPreferences({ theme: 'custom-theme', quietStartup: 'yes' }).value, {});
  assert.equal(projectPreferences({ theme: 'custom-theme' }).diagnostics[0]?.code, 'unsupported-value');
  for (const theme of ['dark', 'light']) assert.deepEqual(validatePreferences({ theme }), { theme });
  for (const value of ['custom-theme', 'light/dark', '']) assert.throws(() => validatePreferences({ theme: value }), ProfileError);
  for (const indent of ['\t', 'a', ' '.repeat(33)]) assert.throws(() => validatePreferences({ markdown: { codeBlockIndent: indent } }), ProfileError);
});

test('rejects accessors without invoking them and copies nested records', () => {
  let calls = 0;
  const input = { get quietStartup() { calls++; return true; } };
  assert.throws(() => projectPreferences(input), ProfileError);
  assert.equal(calls, 0);
  const selected = { compaction: { enabled: true } };
  const result = projectPreferences(selected);
  selected.compaction.enabled = false;
  assert.deepEqual(result.value, { compaction: { enabled: true } });
  for (const value of [null, [], new Date(), Object.create({ quietStartup: true })]) {
    assert.throws(() => validatePreferences(value), ProfileError);
  }
});

test('rejects excess record cardinality and resource-array accessors before evaluation', () => {
  assert.throws(() => projectPreferences(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [String(i), true]))), ProfileError);
  let calls = 0;
  const resources = Object.defineProperty([null], '0', { get() { calls++; return null; } });
  assert.throws(() => validateProfile({ format: 'pi-setup-share', version: 1, resources }), ProfileError);
  assert.equal(calls, 0);
});
