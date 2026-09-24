import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { previewReceiverBackup, writeReceiverBackup } from '../src/literal-backup.ts';
import { previewLiteralArchive } from '../src/literal-archive.ts';
import { writeLiteralArchive } from '../src/literal-writer.ts';

async function fixture(run: (root: string, output: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'pi-literal-backup-'));
  const root = join(workspace, 'receiver');
  const output = join(workspace, 'backup.zip');
  await mkdir(join(root, 'sessions'), { recursive: true });
  await writeFile(join(root, 'settings.json'), '{"synthetic":true}\n');
  await writeFile(join(root, 'sessions', 'history.jsonl'), '{"synthetic":"history"}\n');
  try { await run(root, output); } finally { await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

test('writes and previews a receiver backup without extracting it', async () => {
  await fixture(async (root, output) => {
    const totalBytes = Buffer.byteLength('{"synthetic":true}\n') + Buffer.byteLength('{"synthetic":"history"}\n');
    const result = await writeReceiverBackup(root, output);
    assert.deepEqual(result, { files: 2, directories: 1, symlinks: 0, totalBytes });
    assert.deepEqual(await previewReceiverBackup(output), { sourcePlatform: process.platform, files: 2, directories: 1, symlinks: 0, totalBytes });
    await assert.rejects(previewLiteralArchive(output), { code: 'invalid-state' });
  });
});

test('refuses to read a literal export archive as a receiver backup', async () => {
  await fixture(async (root, output) => {
    const literal = join(output, '..', 'literal.zip');
    await writeLiteralArchive(root, literal);
    await assert.rejects(previewReceiverBackup(literal), { code: 'invalid-state' });
    await assert.rejects(previewLiteralArchive(output), { code: 'invalid-state' });
  });
});

test('rejects a truncated backup and never replaces an existing file', async () => {
  await fixture(async (root, output) => {
    await writeReceiverBackup(root, output);
    const archive = await readFile(output);
    const truncated = join(output, '..', 'truncated.zip');
    await writeFile(truncated, archive.subarray(0, archive.length - 12));
    await assert.rejects(previewReceiverBackup(truncated), { code: 'invalid-state' });
    await assert.rejects(writeReceiverBackup(root, output), { code: 'unsafe-path' });
    assert.deepEqual(await readFile(output), archive);
  });
});
