import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
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

// Builds the normal archive, applies a byte-level mutation and expects rejection without extraction.
async function rejectsMutated(mutate: (archive: Buffer) => Buffer): Promise<void> {
  await fixture(normalEntries(), async path => {
    const mutated = mutate(await readFile(path));
    const target = `${path}.mutated`;
    await writeFile(target, mutated, { mode: 0o600 });
    await assert.rejects(previewLiteralArchive(target), { code: 'invalid-state' });
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

test('literal preview rejects truncation, appended data and an EOCD comment', async () => {
  await rejectsMutated(archive => archive.subarray(0, archive.length - 10));
  await rejectsMutated(archive => Buffer.concat([archive, Buffer.from('synthetic junk')]));
  await rejectsMutated(archive => { const mutated = Buffer.from(archive); mutated.writeUInt16LE(1, mutated.length - 2); return mutated; });
});

test('literal preview rejects unsupported compression, encryption and non-regular entry modes', async () => {
  await rejectsMutated(archive => {
    const mutated = Buffer.from(archive);
    mutated.writeUInt16LE(12, 8);
    const central = mutated.readUInt32LE(mutated.length - 22 + 16);
    mutated.writeUInt16LE(12, central + 10);
    return mutated;
  });
  await rejectsMutated(archive => {
    const mutated = Buffer.from(archive);
    mutated.writeUInt16LE(mutated.readUInt16LE(6) | 1, 6);
    const central = mutated.readUInt32LE(mutated.length - 22 + 16);
    mutated.writeUInt16LE(mutated.readUInt16LE(central + 8) | 1, central + 8);
    return mutated;
  });
  for (const mode of [0xa1ff, 0x41ed]) await rejectsMutated(archive => {
    const mutated = Buffer.from(archive);
    const central = mutated.readUInt32LE(mutated.length - 22 + 16);
    mutated.writeUInt32LE((mode << 16) >>> 0, central + 38);
    return mutated;
  });
});

test('literal preview rejects a central size contradicting the payload entry', async () => {
  await rejectsMutated(archive => {
    const mutated = Buffer.from(archive);
    const central = mutated.readUInt32LE(mutated.length - 22 + 16);
    mutated.writeUInt32LE(content.length - 1, central + 24);
    return mutated;
  });
});

test('literal preview reads a streamed ZIP64 entry whose local header keeps zero sizes', { timeout: 120_000 }, async () => {
  const total = 1024 ** 2;
  const block = Buffer.alloc(64 * 1024);
  const sha256 = createHash('sha256').update(Buffer.alloc(total)).digest('hex');
  const streamed = {
    format: 'pi-setup-share-literal', version: 1, root: 'agentDir', sourcePlatform: 'linux', totalBytes: total,
    entries: [{ path: 'synthetic-streamed.bin', type: 'file', mode: 0o600, size: total, sha256 }],
  };
  const dir = await mkdtemp(join(tmpdir(), 'pi-literal-archive-stream-'));
  const path = join(dir, 'streamed.zip');
  try {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(streamed)), 'manifest.json', { compress: false, forceDosTimestamp: true });
    zip.addReadStream(Readable.from((function* () {
      for (let written = 0; written < total; written += block.length) {
        yield block.subarray(0, Math.min(block.length, total - written));
      }
    })()), 'payload/000001', { size: total, compress: true, forceZip64Format: true, forceDosTimestamp: true });
    zip.end({ forceZip64Format: true, comment: '' });
    await pipeline(zip.outputStream, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    const result = await previewLiteralArchive(path, { maxExpandedBytes: total });
    assert.deepEqual(result, { sourcePlatform: 'linux', files: 1, directories: 0, symlinks: 0, totalBytes: total });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('literal preview rejects a future manifest version inside an otherwise valid archive', async () => {
  await rejectsArchive([
    { name: 'manifest.json', bytes: Buffer.from(JSON.stringify({ ...manifest, version: 2 })) },
    { name: 'payload/000001', bytes: content },
  ]);
});

test('literal preview reads a synthetic ZIP64 entry whose uncompressed size exceeds 4 GiB', { timeout: 600_000 }, async () => {
  const total = 4 * 1024 ** 3 + 1;
  const block = Buffer.alloc(1024 ** 2);
  const hash = createHash('sha256');
  for (let written = 0; written < total; written += block.length) {
    hash.update(block.subarray(0, Math.min(block.length, total - written)));
  }
  const sha256 = hash.digest('hex');
  const large = {
    format: 'pi-setup-share-literal', version: 1, root: 'agentDir', sourcePlatform: 'linux', totalBytes: total,
    entries: [{ path: 'synthetic-large.bin', type: 'file', mode: 0o600, size: total, sha256 }],
  };
  const dir = await mkdtemp(join(tmpdir(), 'pi-literal-archive-large-'));
  const path = join(dir, 'large.zip');
  try {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(large)), 'manifest.json', { compress: false, forceDosTimestamp: true });
    zip.addReadStream(Readable.from((function* () {
      for (let written = 0; written < total; written += block.length) {
        yield block.subarray(0, Math.min(block.length, total - written));
      }
    })()), 'payload/000001', { size: total, compress: true, forceZip64Format: true, forceDosTimestamp: true });
    zip.end({ forceZip64Format: true, comment: '' });
    await pipeline(zip.outputStream, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    const result = await previewLiteralArchive(path, { maxExpandedBytes: total });
    assert.deepEqual(result, { sourcePlatform: 'linux', files: 1, directories: 0, symlinks: 0, totalBytes: total });
    await assert.rejects(previewLiteralArchive(path), { code: 'limit-exceeded' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
