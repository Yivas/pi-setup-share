import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonByteLength, parseBoundedJson, stringifyBounded } from '../src/json.ts';
import { ProfileError } from '../src/profile.ts';

test('counts exact UTF-8 JSON size including escaping, indentation and final newline', () => {
  const values = [null, true, false, 0, -0, 1e30, [], {}, ['x', 5], { nested: ['\0\b\t\n\f\r', '\\"', '字', '😀', '\ud800', '\udc00'] }, { '字\0': { x: 'value' } }];
  for (const value of values) for (const pretty of [true, false]) {
    const expected = `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`;
    const bytes = Buffer.byteLength(expected);
    assert.equal(stringifyBounded(value, bytes, pretty), expected);
    assert.throws(() => stringifyBounded(value, bytes - 1, pretty), ProfileError);
  }
});

test('rejects non-JSON values, cycles and getters before serialization', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const input of [undefined, Infinity, () => {}, cycle]) assert.throws(() => stringifyBounded(input, 1000), ProfileError);
  let calls = 0;
  const input = Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; return 1; } });
  assert.throws(() => stringifyBounded(input, 1000), ProfileError);
  assert.equal(calls, 0);
});

test('bounds local JSON bytes, structure and cardinality before parsing', () => {
  assert.deepEqual(parseBoundedJson('\ufeff{"example":true}'), { example: true });
  assert.throws(() => parseBoundedJson('"abc"', 4), ProfileError);
  assert.throws(() => parseBoundedJson('['.repeat(33) + ']'.repeat(33)), ProfileError);
  assert.throws(() => parseBoundedJson(`[${Array(65538).fill('0').join(',')}]`), ProfileError);
  assert.deepEqual(parseBoundedJson('{"text":"[[[\\\""}'), { text: '[[["' });
  assert.throws(() => parseBoundedJson('synthetic-secret'), error => error instanceof ProfileError && !error.message.includes('synthetic-secret'));
});

test('measures exactly the bytes JSON.stringify produces and stops at the limit', () => {
  const samples: unknown[] = [
    { kind: 'prompt', path: 'a.md', encoding: 'utf8', content: 'plain "quoted" \ back\tslash\n\u0000\u001f\u007f' },
    { text: 'é中😀', lone: '\ud800x\udc00', list: [1, -2.5, true, false, null, [], {}] },
  ];
  for (const sample of samples) {
    for (const pretty of [false, true]) {
      const expected = Buffer.byteLength(JSON.stringify(sample, null, pretty ? 2 : undefined));
      assert.equal(jsonByteLength(sample, expected, pretty), expected);
      assert.equal(jsonByteLength(sample, expected - 1, pretty), null);
    }
  }
});
