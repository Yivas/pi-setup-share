import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';
import * as yazl from 'yazl';
import { previewLiteralArchive } from '../src/literal-archive.ts';

const content = Buffer.from('synthetic data, not Pi configuration');
const manifest = {
  format: 'pi-setup-share-literal', version: 1, root: 'agentDir', sourcePlatform: 'linux',
  totalBytes: content.length,
  entries: [
    { path: 'config', type: 'directory', mode: 0o700 },
    { path: 'config/example.txt', type: 'file', mode: 0o600, size: content.length,
      sha256: createHash('sha256').update(content).digest('hex') },
  ],
};

async function fixture(entries: readonly { name: string; bytes: Buffer }[], callback: (path: string) => Promise<void>,
  zip64 = false, forceDosTimestamp = true): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-literal-archive-test-'));
  const path = join(dir, 'synthetic.zip');
  try {
    const zip = new yazl.ZipFile();
    for (const entry of entries) zip.addBuffer(entry.bytes, entry.name,
      { compress: false, forceZip64Format: zip64, forceDosTimestamp });
    zip.end({ forceZip64Format: zip64, comment: '' });
    await pipeline(zip.outputStream, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    await callback(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const normalEntries = () => [
  { name: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) },
  { name: 'payload/000001', bytes: content },
];

function injectFirstLocalExtra(archive: Buffer, extra: Buffer): Buffer {
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.equal(archive.readUInt16LE(28), 0);
  const firstData = 30 + archive.readUInt16LE(26);
  const result = Buffer.concat([archive.subarray(0, firstData), extra, archive.subarray(firstData)]);
  result.writeUInt16LE(extra.length, 28);
  const eocd = result.length - 22;
  const oldCentral = result.readUInt32LE(eocd + 16);
  const central = oldCentral + extra.length;
  result.writeUInt32LE(central, eocd + 16);
  const firstCentralSize = 46 + result.readUInt16LE(central + 28) + result.readUInt16LE(central + 30)
    + result.readUInt16LE(central + 32);
  const secondCentral = central + firstCentralSize;
  assert.equal(result.readUInt32LE(secondCentral), 0x02014b50);
  result.writeUInt32LE(result.readUInt32LE(secondCentral + 42) + extra.length, secondCentral + 42);
  return result;
}

async function rejectsArchive(entries: { name: string; bytes: Buffer }[]): Promise<void> {
  await fixture(entries, async path => {
    await assert.rejects(previewLiteralArchive(path), { code: 'invalid-state' });
  });
}

test('literal preview checks synthetic bytes without extracting or reporting paths', async () => {
  await fixture(normalEntries(), async path => {
    const result = await previewLiteralArchive(path);
    assert.deepEqual(result, { sourcePlatform: 'linux', files: 1, directories: 1, symlinks: 0, totalBytes: content.length });
    assert.deepEqual(Object.keys(result).sort(), ['directories', 'files', 'sourcePlatform', 'symlinks', 'totalBytes']);
    const archive = await readFile(path);
    assert.ok(archive.length > content.length);
  });
});

test('literal preview checks forced ZIP64 without extracting or returning paths', async () => {
  await fixture(normalEntries(), async path => {
    assert.equal((await previewLiteralArchive(path)).files, 1);
  }, true);
});

test('literal preview reads a synthetic ZIP64 directory with 65,536 physical entries', { timeout: 120_000 }, async () => {
  const count = 65_535;
  const empty = Buffer.alloc(0);
  const emptyHash = createHash('sha256').update(empty).digest('hex');
  const entries = Array.from({ length: count }, (_, index) => ({
    path: `f${String(index + 1).padStart(6, '0')}`, type: 'file', mode: 0o600,
    size: 0, sha256: emptyHash,
  }));
  const archiveEntries = [{ name: 'manifest.json', bytes: Buffer.from(JSON.stringify({
    ...manifest, totalBytes: 0, entries,
  })) }];
  for (let index = 1; index <= count; index++) {
    archiveEntries.push({ name: `payload/${String(index).padStart(6, '0')}`, bytes: empty });
  }
  await fixture(archiveEntries, async path => {
    assert.equal((await previewLiteralArchive(path)).files, count);
  });
});

test('literal preview rejects extended timestamps outside the generated format', async () => {
  await fixture(normalEntries(), async path => {
    await assert.rejects(previewLiteralArchive(path), { code: 'invalid-state' });
  }, false, false);
});

test('literal preview rejects unknown and duplicate extras in the local header', async () => {
  await fixture(normalEntries(), async path => {
    const original = await readFile(path);
    const unknown = Buffer.from([0x34, 0x12, 0, 0]);
    await writeFile(path, injectFirstLocalExtra(original, unknown));
    await assert.rejects(previewLiteralArchive(path), { code: 'invalid-state' });
    const timestamp = Buffer.from([0x55, 0x54, 5, 0, 1, 0, 0, 0, 0]);
    await writeFile(path, injectFirstLocalExtra(original, Buffer.concat([timestamp, timestamp])));
    await assert.rejects(previewLiteralArchive(path), { code: 'invalid-state' });
  });
});

test('literal preview requires an explicit larger budget and honors cancellation', async () => {
  await fixture(normalEntries(), async path => {
    await assert.rejects(previewLiteralArchive(path, { maxExpandedBytes: content.length - 1 }),
      { code: 'limit-exceeded' });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(previewLiteralArchive(path, { signal: controller.signal }), { code: 'aborted' });
  });
});

test('literal preview rejects extra, missing and reordered physical entries', async () => {
  const [first] = normalEntries();
  assert.ok(first);
  await rejectsArchive([...normalEntries(), { name: 'payload', bytes: content }]);
  await rejectsArchive([first]);
  await rejectsArchive(normalEntries().reverse());
  await rejectsArchive([
    { name: 'literal-manifest.json', bytes: first.bytes },
    { name: 'content/000000000', bytes: content },
  ]);
});

test('literal preview rejects mismatched declared SHA-256, malformed manifest and duplicate ZIP names', async () => {
  const [first, second] = normalEntries();
  assert.ok(first && second);
  await rejectsArchive([
    { name: 'manifest.json', bytes: Buffer.from(JSON.stringify({ ...manifest, entries: [
      manifest.entries[0], { ...manifest.entries[1], sha256: '0'.repeat(64) },
    ] })) },
    second,
  ]);
  await rejectsArchive([{ name: 'manifest.json', bytes: Buffer.from('{broken') }, second]);
  await rejectsArchive([first, second, second]);
});

test('literal preview rejects changed file bytes even when length is unchanged', async () => {
  await fixture(normalEntries(), async path => {
    const zip = await readFile(path);
    const at = zip.indexOf(content);
    assert.ok(at > 0);
    zip[at] = (zip[at] ?? 0) ^ 1;
    await writeFile(path, zip);
    await assert.rejects(previewLiteralArchive(path), { code: 'invalid-state' });
  });
});
