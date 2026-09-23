import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLiteralManifest } from '../src/literal-manifest.ts';

const fixture = () => ({
  format: 'pi-setup-share-literal', version: 1, root: 'agentDir', sourcePlatform: 'win32',
  totalBytes: 8,
  entries: [
    { path: 'npm', type: 'directory', mode: 0o700 },
    { path: 'npm/package.json', type: 'file', mode: 0o600, size: 8, sha256: 'a'.repeat(64) },
    { path: 'settings.json', type: 'symlink', target: 'npm/package.json' },
  ],
});

test('accepts a complete synthetic literal manifest without changing its input', () => {
  const input = fixture();
  const result = validateLiteralManifest(input);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.equal(Object.isFrozen(result.entries), true);
  const file = input.entries[1];
  assert.ok(file);
  file.path = 'changed';
  assert.equal(result.entries.at(1)?.path, 'npm/package.json');
});

test('rejects unexpected fields, future formats, forged totals and invalid file hashes', () => {
  const valid = fixture();
  for (const bad of [
    { ...valid, format: 'pi-setup-share' },
    { ...valid, version: 2 },
    { ...valid, totalBytes: 7 },
    { ...valid, sourcePlatform: 'unknown' },
    { ...valid, extra: 'secret' },
    { ...valid, entries: valid.entries.map((entry, index) => index === 1 ? { ...entry, sha256: 'a'.repeat(63) } : entry) },
    { ...valid, entries: valid.entries.map((entry, index) => index === 1 ? { ...entry, mode: 0o100600 } : entry) },
  ]) assert.throws(() => validateLiteralManifest(bad), { code: 'invalid-state' });
});

test('rejects traversal, device names, control characters, case and Unicode collisions', () => {
  const base = fixture();
  const paths = ['../secret', '/absolute', 'C:/file', 'nested\\file', 'npm//a', 'npm/./a',
    'npm/../a', 'CON.txt', 'a. ', 'bad\0name', 'bad\ud800name', 'e\u0301'];
  for (const path of paths) {
    const manifest = { ...base, totalBytes: 8, entries: [...base.entries, { path, type: 'directory', mode: 0o700 }] };
    assert.throws(() => validateLiteralManifest(manifest), { code: 'unsafe-path' }, path);
  }
  for (const path of ['NPM', 'ｎｐｍ']) {
    const entries = [...base.entries, { path, type: 'directory', mode: 0o700 }]
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    assert.throws(() => validateLiteralManifest({ ...base, entries }), { code: 'unsafe-path' });
  }
  const greek = { ...base, totalBytes: 0, entries: [
    { path: 'σ', type: 'directory', mode: 0o700 },
    { path: 'ς', type: 'directory', mode: 0o700 },
  ] };
  greek.entries.sort((left, right) => left.path < right.path ? -1 : 1);
  assert.throws(() => validateLiteralManifest(greek), { code: 'unsafe-path' });
});

test('rejects missing parents, a file used as a directory and out-of-order entries', () => {
  const base = fixture();
  for (const entries of [
    base.entries.filter(entry => entry.path !== 'npm'),
    [...base.entries, { path: 'npm/package.json/child', type: 'directory', mode: 0o700 }],
    [...base.entries].reverse(),
  ]) assert.throws(() => validateLiteralManifest({ ...base, entries }), { code: 'invalid-state' });
});

test('accepts an empty root and fictional session files without portable filtering', () => {
  const empty = { ...fixture(), entries: [], totalBytes: 0 };
  assert.deepEqual(validateLiteralManifest(empty).entries, []);
  const withSession = { ...fixture(), entries: [
    { path: 'sessions', type: 'directory', mode: 0o700 },
    { path: 'sessions/fake.json', type: 'file', mode: 0o600, size: 8, sha256: 'a'.repeat(64) },
  ], totalBytes: 8 };
  assert.equal(validateLiteralManifest(withSession).entries.length, 2);
});

test('rejects excess entries, sizes and a symlink cycle', () => {
  const base = fixture();
  assert.throws(() => validateLiteralManifest({ ...base, totalBytes: 64 * 1024 ** 3 + 1 }), { code: 'limit-exceeded' });
  assert.throws(() => validateLiteralManifest({ ...base, entries: new Array(250_001) }), { code: 'limit-exceeded' });
  const cycle = { ...base, totalBytes: 0, entries: [
    { path: 'a', type: 'symlink', target: 'b' },
    { path: 'b', type: 'symlink', target: 'a' },
  ] };
  assert.throws(() => validateLiteralManifest(cycle), { code: 'unsafe-path' });
});

test('does not normalize past an intermediate symlink before applying parent segments', () => {
  const base = { format: 'pi-setup-share-literal', version: 1, root: 'agentDir',
    sourcePlatform: 'win32', totalBytes: 0 };
  const entries = [
    { path: 'dir', type: 'directory', mode: 0o700 },
    { path: 'nested', type: 'directory', mode: 0o700 },
    { path: 'nested/a', type: 'symlink', target: '../dir' },
    { path: 'nested/link', type: 'symlink', target: 'a/../../outside' },
    { path: 'outside', type: 'file', mode: 0o600, size: 0, sha256: '0'.repeat(64) },
  ];
  assert.throws(() => validateLiteralManifest({ ...base, entries }), { code: 'unsafe-path' });
  const internal = entries.map(entry => entry.path === 'nested/link'
    ? { path: 'nested/link', type: 'symlink', target: 'a/../outside' } : entry);
  assert.equal(validateLiteralManifest({ ...base, entries: internal }).entries.length, 5);
});

test('checks a long internal link chain without repeating every suffix', () => {
  const links = Array.from({ length: 64 }, (_, index) => ({
    path: `links/${String(index).padStart(3, '0')}`, type: 'symlink',
    target: index === 63 ? '../target' : String(index + 1).padStart(3, '0'),
  }));
  const manifest = { ...fixture(), totalBytes: 0, entries: [
    { path: 'links', type: 'directory', mode: 0o700 }, ...links,
    { path: 'target', type: 'file', size: 0, sha256: '0'.repeat(64), mode: 0o600 },
  ] };
  assert.equal(validateLiteralManifest(manifest).entries.length, 66);
});

test('requires link targets to resolve to an existing entry within the manifest', () => {
  const base = fixture();
  for (const target of ['../../elsewhere', 'C:/other', '/absolute', 'missing', 'settings.json', 'npm\\package.json']) {
    const entries = base.entries.map(entry => entry.type === 'symlink' ? { ...entry, target } : entry);
    assert.throws(() => validateLiteralManifest({ ...base, entries }), { code: 'unsafe-path' }, target);
  }
  const internalParent = { ...base, entries: [base.entries[0],
    { path: 'npm/link', type: 'symlink', target: '../npm/package.json' },
    base.entries[1],
    { path: 'settings.json', type: 'symlink', target: 'npm/link' },
  ] };
  assert.deepEqual(validateLiteralManifest(internalParent).entries.map(entry => entry.path),
    ['npm', 'npm/link', 'npm/package.json', 'settings.json']);
});
