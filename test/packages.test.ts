import assert from 'node:assert/strict';
import test from 'node:test';
import { packageIdentity, projectPackages, validatePackages } from '../src/packages.ts';
import { parseProfile, ProfileError } from '../src/profile.ts';

const commit = 'a'.repeat(40);

test('accepts pinned npm and HTTPS Git without installing or resolving sources', () => {
  const output = projectPackages(['npm:example-tools@1.2.3', 'npm:@example/tools@1.2.3-beta.1+build', `git:github.com/example/tools@${commit}`]);
  assert.deepEqual(output.diagnostics, []);
  assert.deepEqual(output.value, [{ source: 'npm:example-tools@1.2.3' }, { source: 'npm:@example/tools@1.2.3-beta.1+build' }, { source: `git:https://github.com/example/tools@${commit}` }]);
  assert.deepEqual(validatePackages(output.value), output.value);
});

test('omits unpinned, ranged, local, credentialed or private-address sources', () => {
  for (const source of ['npm:example-tools', 'npm:example-tools@latest', 'npm:example-tools@^1.0.0', 'npm:example-tools@01.2.3', 'npm:example-tools@1.2.3-01', 'file:/synthetic', '/synthetic', `git:https://user:secret@github.com/example/tools@${commit}`, `git:127.0.0.1/example/tools@${commit}`, `git:https://@example.com/tools/repo@${commit}`, `git:https://:@example.com/tools/repo@${commit}`, `git:github.com/example/tools@main`, `git:github.com/example/../tools@${commit}`]) {
    const result = projectPackages([source]);
    assert.deepEqual(result.value, []);
    assert.deepEqual(result.diagnostics, [{ field: 'packages[0]', code: 'unsupported-value' }]);
  }
});

test('preserves absence, false and empty filters without treating them as an install gate', () => {
  const input = [{ source: 'npm:example-tools@1.2.3', autoload: false, extensions: [], skills: ['skills/**', '!skills/old/*'], prompts: ['+prompts/example.md'] }];
  const output = validatePackages(input);
  assert.deepEqual(output, input);
  assert.equal(Object.hasOwn(output[0] ?? {}, 'themes'), false);
  input[0]?.skills.push('new/*');
  assert.equal(output[0]?.skills?.length, 2);
});

test('rejects traversal, absolute paths and complex expansion filters', () => {
  for (const pattern of ['../outside', '/absolute', '+/absolute', 'C:\\private', '**/../file', '{..,safe}/file', '@(..)/file', '!../file', 'a//b', '-']) {
    assert.throws(() => validatePackages([{ source: 'npm:example-tools@1.2.3', extensions: [pattern] }]), ProfileError);
  }
});

test('rejects duplicates by package identity, including Git suffix aliases', () => {
  assert.equal(packageIdentity('npm:@example/tools@1.2.3'), 'npm:@example/tools');
  assert.equal(packageIdentity(`git:github.com/example/tools.git@${commit}`), packageIdentity(`git:https://github.com/example/tools@${commit}`));
  assert.throws(() => validatePackages([{ source: 'npm:example-tools@1.2.3' }, { source: 'npm:example-tools@2.0.0' }]), ProfileError);
  assert.equal(projectPackages(['npm:example-tools@1.2.3', 'npm:example-tools@2.0.0']).value.length, 1);
});

test('strict import rejects unknown fields and export diagnoses them without values', () => {
  assert.throws(() => validatePackages([{ source: 'npm:example-tools@1.2.3', credentials: 'synthetic-secret' }]), ProfileError);
  const result = projectPackages([{ source: 'npm:example-tools@1.2.3', credentials: 'synthetic-secret' }]);
  assert.deepEqual(result.value, [{ source: 'npm:example-tools@1.2.3' }]);
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
});

test('bounds counts and rejects accessors without invocation', () => {
  assert.throws(() => validatePackages(Array(65).fill({ source: 'npm:example-tools@1.2.3' })), ProfileError);
  let calls = 0;
  const input = Object.defineProperty({}, 'source', { enumerable: true, get() { calls++; return 'npm:example-tools@1.2.3'; } });
  assert.deepEqual(projectPackages([input]).value, []);
  assert.equal(calls, 0);
});

test('profile envelope roundtrips explicit empty and pinned packages', () => {
  for (const packages of [[], [{ source: 'npm:example-tools@1.2.3' }]]) {
    const profile = { format: 'pi-setup-share', version: 1, resources: [], packages };
    assert.deepEqual(parseProfile(JSON.stringify(profile)), profile);
  }
});
