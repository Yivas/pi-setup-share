import assert from 'node:assert/strict';
import test from 'node:test';
import { projectKeybindings, validateKeybindings } from '../src/keybindings.ts';
import { parseProfile, ProfileError } from '../src/profile.ts';

const action = 'tui.editor.cursorLeft';

test('imports explicit namespaced shortcuts and preserves empty arrays without defaults', () => {
  const keybindings = { [action]: ['left', 'ctrl+b'], 'app.suspend': [] };
  assert.deepEqual(parseProfile(JSON.stringify({ format: 'pi-setup-share', version: 1, resources: [], keybindings })).keybindings, keybindings);
  assert.deepEqual(validateKeybindings({}), {});
});

test('accepts documented key symbols, special keys and unique modifier combinations', () => {
  for (const key of ['ctrl+shift+x', 'alt+ctrl+x', 'super+k', 'ctrl+super+k', 'ctrl+1', 'pageUp', 'ctrl+pageDown', 'escape', 'return', 'f12', "'", '\\', '|', '!']) {
    assert.deepEqual(validateKeybindings({ [action]: key }), { [action]: key });
  }
});

test('rejects malformed shortcuts and duplicate aliases within one action', () => {
  for (const key of ['', '+', 'ctrl++', 'ctrl+ctrl+x', 'CTRL+x', 'x y', 'meta+x', 'f13', 'ctrl+f1', 'shift+f12', 'ctrl+', 'a'.repeat(65)]) {
    assert.throws(() => validateKeybindings({ [action]: key }), ProfileError);
  }
  for (const keys of [['esc', 'escape'], ['return', 'enter'], ['alt+ctrl+x', 'ctrl+alt+x']]) {
    assert.throws(() => validateKeybindings({ [action]: keys }), ProfileError);
  }
});

test('omits unknown actions without disclosing their names or values', () => {
  const result = projectKeybindings({ 'synthetic-secret-name': 'synthetic-secret', cursorUp: 'up', [action]: 'left' });
  assert.deepEqual(result.value, { [action]: 'left' });
  assert.equal(result.diagnostics.length, 2);
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
  assert.throws(() => validateKeybindings({ cursorUp: 'up' }), ProfileError);
});

test('reports shared keys across contexts without rejecting valid contextual bindings', () => {
  const selected = { 'tui.input.copy': 'ctrl+c', 'app.clear': 'ctrl+c' };
  assert.deepEqual(validateKeybindings(selected), selected);
  assert.equal(projectKeybindings(selected).diagnostics[0]?.code, 'shared-key');
});

test('copies arrays and omits invalid arrays without invoking getters', () => {
  const keys = ['left', 'ctrl+b'];
  const result = projectKeybindings({ [action]: keys });
  keys.push('right');
  assert.deepEqual(result.value[action], ['left', 'ctrl+b']);
  let calls = 0;
  const accessor = Object.defineProperty([null], '0', { get() { calls++; return 'left'; } });
  assert.deepEqual(projectKeybindings({ [action]: accessor }).value, {});
  assert.equal(calls, 0);
  for (const value of [null, 3, new Array(1), Array.from({ length: 17 }, () => 'left')]) {
    assert.throws(() => validateKeybindings({ [action]: value }), ProfileError);
  }
});
