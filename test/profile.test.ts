import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseProfile, validateProfile, ProfileError, PROFILE_LIMITS,
} from '../src/profile.ts';
import type { ProfileErrorCode, ProfileResource } from '../src/profile.ts';

function resource(path = 'example.md', content = 'Synthetic example'): ProfileResource {
  return { kind: 'prompt', path, encoding: 'utf8', content };
}

function profile(resources: ProfileResource[] = []) {
  return { format: 'pi-setup-share', version: 1, resources };
}

function rejects(value: unknown, code: ProfileErrorCode) {
  assert.throws(() => parseProfile(JSON.stringify(value)), (error: unknown) => {
    assert.ok(error instanceof ProfileError);
    assert.equal(error.code, code);
    return true;
  });
}

test('parses an empty profile and selected text and binary resources', () => {
  const input = profile([
    resource('notes/example.md', 'Synthetic text: ñ'),
    { kind: 'skill', path: 'example/pixel.bin', encoding: 'base64', content: 'AP8=' },
  ]);
  assert.deepEqual(parseProfile(JSON.stringify(input)), input);
  assert.deepEqual(parseProfile(JSON.stringify(profile())), profile());
});

test('validation copies records and arrays rather than exposing mutable input', () => {
  const input = profile([resource()]);
  const validated = validateProfile(input);
  assert.ok(input.resources[0]);
  input.resources[0].content = 'Changed after validation';
  input.resources.push(resource('second.md'));
  assert.equal(validated.resources.length, 1);
  assert.equal(validated.resources[0]?.content, 'Synthetic example');
});

test('rejects unsupported versions without exposing the imported value', () => {
  for (const version of [0, 2, '1', true, null, 'synthetic-secret-marker']) {
    rejects({ ...profile(), version }, 'unsupported-version');
  }
  assert.throws(() => parseProfile('{"version":"synthetic-secret-marker"'), error => {
    assert.ok(error instanceof ProfileError);
    assert.equal(error.message, 'invalid-json');
    assert.ok(!error.message.includes('synthetic-secret-marker'));
    return true;
  });
});

test('rejects malformed envelopes and unknown fields, including prototype keys', () => {
  for (const value of [null, [], {}, { ...profile(), format: 'different' },
    { ...profile(), resources: {} }, { ...profile(), credentials: {} }]) {
    rejects(value, 'invalid-shape');
  }
  assert.throws(() => parseProfile(
    '{"format":"pi-setup-share","version":1,"resources":[],"__proto__":{}}',
  ), ProfileError);
});

test('rejects unknown resource kinds, encodings, fields and non-string contents', () => {
  for (const entry of [null, [], { ...resource(), kind: 'session' },
    { ...resource(), encoding: 'hex' }, { ...resource(), content: 4 },
    { ...resource(), credential: 'synthetic-only' }, { kind: 'prompt' }]) {
    rejects({ ...profile(), resources: [entry] }, 'invalid-shape');
  }
});

test('rejects record accessors without calling them', () => {
  let called = false;
  const input = profile();
  Object.defineProperty(input, 'format', { get() { called = true; return 'pi-setup-share'; } });
  assert.throws(() => validateProfile(input), ProfileError);
  assert.equal(called, false);
  assert.throws(() => validateProfile(Object.assign(new Date(), profile())), ProfileError);
});

test('rejects absolute, traversal, Windows device and misleading paths', () => {
  const invalid = [
    '', '/file.md', '../file.md', 'dir/../file.md', './file.md', 'dir//file.md',
    'dir/', 'C:/file.md', 'C:file.md', '\\\\server\\file.md', 'dir\\file.md',
    'name:stream', 'nul', 'CON.txt', 'dir/lpt9.md', 'COM¹.txt', 'aux.',
    'CONIN$', 'CONOUT$', 'dir/conin$.txt', 'dir/ConOut$',
    'file.md ', 'trailing./file', ' leading.md', 'name?.md', 'name*.md',
    'name|.md', 'name<.md', 'a\u0000.md', 'a\u001b.md', 'a\u202e.md',
    'cafe\u0301.md', '\ud800.md', 'x'.repeat(PROFILE_LIMITS.segmentBytes + 1),
  ];
  for (const path of invalid) rejects(profile([resource(path)]), 'invalid-path');
  rejects(profile([resource(Array(4).fill('x'.repeat(70)).join('/'))]), 'invalid-path');
});

test('allows NFC Unicode, nested paths, and non-device names', () => {
  for (const path of ['diseño/ejemplo.md', 'config.v1.json', 'console.md', 'COM10.md']) {
    assert.equal(parseProfile(JSON.stringify(profile([resource(path)]))).resources[0]?.path, path);
  }
});

test('rejects duplicate names and file-directory conflicts in either order', () => {
  for (const paths of [
    ['same.md', 'SAME.md'], ['folder', 'folder/item.md'],
    ['folder/item.md', 'folder'], ['folder', 'folder-other.md', 'folder/item.md'],
    ['straße.md', 'STRASSE.md'], ['ẞ.md', 'SS.md'], ['ẞ.md', 'ß.md'],
  ]) rejects(profile(paths.map(path => resource(path))), 'path-conflict');
});

test('keeps destination namespaces separate for different kinds', () => {
  const entries = [resource(), { ...resource(), kind: 'agent' as const }];
  assert.equal(parseProfile(JSON.stringify(profile(entries))).resources.length, 2);
});

test('requires canonical base64 and lossless UTF-8', () => {
  for (const content of ['!invalid', 'YQ', 'YQ===', 'YR==', 'Y Q==', 'YQ==\n', 'é']) {
    rejects(profile([{ ...resource(), encoding: 'base64', content }]), 'invalid-content');
  }
  rejects(profile([resource('example.md', '\ud800')]), 'invalid-content');
  for (const encoding of ['utf8', 'base64'] as const) {
    assert.equal(parseProfile(JSON.stringify(profile([{ ...resource(), encoding, content: '' }])))
      .resources[0]?.content, '');
  }
});

test('limits UTF-8 bytes, not just JavaScript string length', () => {
  const exactlyOneMiB = 'é'.repeat(PROFILE_LIMITS.fileBytes / 2);
  assert.equal(parseProfile(JSON.stringify(profile([resource('exact.md', exactlyOneMiB)])))
    .resources.length, 1);
  rejects(profile([resource('large.md', `${exactlyOneMiB}é`)]), 'limit-exceeded');
});

test('limits decoded base64 size', () => {
  const content = Buffer.alloc(PROFILE_LIMITS.fileBytes + 1).toString('base64');
  rejects(profile([{ ...resource(), encoding: 'base64', content }]), 'limit-exceeded');
});

test('limits resource count and aggregate decoded bytes', () => {
  const maximum = Array.from({ length: PROFILE_LIMITS.resources }, (_, index) => resource(`${index}.md`, ''));
  assert.equal(validateProfile(profile(maximum)).resources.length, PROFILE_LIMITS.resources);
  rejects(profile([...maximum, resource('extra.md', '')]), 'limit-exceeded');
  const content = 'x'.repeat(PROFILE_LIMITS.fileBytes);
  const entries = Array.from({ length: 8 }, (_, index) => resource(`${index}.md`, content));
  assert.equal(validateProfile(profile(entries)).resources.length, 8);
  rejects(profile([...entries, resource('extra.md', 'x')]), 'limit-exceeded');
});

test('bounds JSON bytes and nesting before parsing', () => {
  assert.throws(() => parseProfile(' '.repeat(PROFILE_LIMITS.jsonBytes + 1)), (error: unknown) => {
    assert.ok(error instanceof ProfileError);
    assert.equal(error.code, 'limit-exceeded');
    return true;
  });
  const depth = PROFILE_LIMITS.depth + 1;
  assert.throws(() => parseProfile(`${'['.repeat(depth)}0${']'.repeat(depth)}`), (error: unknown) => {
    assert.ok(error instanceof ProfileError);
    assert.equal(error.code, 'limit-exceeded');
    return true;
  });
});

test('ignores braces and escaped quotes inside resource text during depth checks', () => {
  const input = profile([resource('example.md', '{{{{{{{{{{ \\" [ [[[[[[[[[[')]);
  assert.deepEqual(parseProfile(JSON.stringify(input)), input);
});
