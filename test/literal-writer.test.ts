import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { materializeLiteralArchive, previewLiteralArchive } from '../src/literal-archive.ts';
import { writeLiteralArchive } from '../src/literal-writer.ts';

async function fixture(run: (root: string, output: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'pi-literal-writer-'));
  const root = join(workspace, 'agent');
  const output = join(workspace, 'archive.zip');
  await mkdir(join(root, 'nested', 'empty'), { recursive: true });
  try { await run(root, output); } finally { await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

async function syntheticTree(root: string): Promise<number> {
  const first = '{"synthetic":true}\n';
  const second = 'synthetic note\n';
  await writeFile(join(root, 'settings.json'), first);
  await writeFile(join(root, 'nested', 'note.txt'), second);
  return Buffer.byteLength(first) + Buffer.byteLength(second);
}

test('writes a synthetic tree that the literal reader verifies without extraction', async () => {
  await fixture(async (root, output) => {
    const totalBytes = await syntheticTree(root);
    const result = await writeLiteralArchive(root, output);
    assert.deepEqual(result, { files: 2, directories: 2, symlinks: 0, totalBytes });
    assert.deepEqual(await previewLiteralArchive(output), { sourcePlatform: process.platform, files: 2, directories: 2, symlinks: 0, totalBytes });
    const leftovers = (await readdir(join(output, '..'))).filter(name => name.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

test('stores relative symlinks as manifest entries and refuses escaping ones', async () => {
  await fixture(async (root, output) => {
    const totalBytes = await syntheticTree(root);
    const escaping = await mkdtemp(join(tmpdir(), 'pi-literal-writer-escape-'));
    try {
      await mkdir(join(escaping, 'agent'));
      await writeFile(join(escaping, 'target.txt'), 'synthetic outside');
      try { await symlink(join(escaping, 'target.txt'), join(escaping, 'agent', 'absolute.txt')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      }
      await symlink(escaping, join(escaping, 'agent', 'outside'), 'junction');
      await assert.rejects(writeLiteralArchive(join(escaping, 'agent'), join(escaping, 'out.zip')), { code: 'unsafe-path' });
    } finally { await rm(escaping, { recursive: true, force: true }); }
    // File symlinks need a privilege on Windows runners; the junction case above covers the refusal.
    const relative = join(root, 'link.json');
    try { await symlink('settings.json', relative); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const result = await writeLiteralArchive(root, output);
    assert.equal(result.symlinks, 1);
    assert.deepEqual(await previewLiteralArchive(output), { sourcePlatform: process.platform, files: 2, directories: 2, symlinks: 1, totalBytes });
  });
});

test('treats hardlinked paths as independent files with identical bytes', async () => {
  await fixture(async (root, output) => {
    await writeFile(join(root, 'original.txt'), 'synthetic hardlink content\n');
    await link(join(root, 'original.txt'), join(root, 'second.txt'));
    const result = await writeLiteralArchive(root, output);
    assert.equal(result.files, 2);
    assert.equal(result.totalBytes, 'synthetic hardlink content\n'.length * 2);
    assert.deepEqual(await previewLiteralArchive(output), { sourcePlatform: process.platform, files: 2, directories: 2, symlinks: 0, totalBytes: result.totalBytes });
  });
});

test('never replaces an existing destination', async () => {
  await fixture(async (root, output) => {
    await syntheticTree(root);
    await writeFile(output, 'synthetic existing bytes');
    await assert.rejects(writeLiteralArchive(root, output), { code: 'unsafe-path' });
    assert.equal(await readFile(output, 'utf8'), 'synthetic existing bytes');
  });
});

test('enforces the total byte limit before publishing', async () => {
  await fixture(async (root, output) => {
    await syntheticTree(root);
    await assert.rejects(writeLiteralArchive(root, output, { maxTotalBytes: 8 }), { code: 'limit-exceeded' });
    assert.deepEqual((await readdir(join(output, '..'))).filter(name => name.includes('.tmp')), []);
  });
});

test('honors cancellation without leaving an archive or temporary file', async () => {
  await fixture(async (root, output) => {
    await syntheticTree(root);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(writeLiteralArchive(root, output, { signal: controller.signal }), { code: 'aborted' });
    assert.deepEqual((await readdir(join(output, '..'))).sort(), ['agent']);
  });
});

test('refuses a symlinked root and a destination inside the root', async () => {
  await fixture(async (root, output) => {
    await syntheticTree(root);
    await assert.rejects(writeLiteralArchive(root, join(root, 'inside.zip')), { code: 'unsafe-path' });
    const linked = `${root}-link`;
    await symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(writeLiteralArchive(linked, output), { code: 'unsafe-path' });
  });
});

test('materializes a verified archive into a fresh private directory', async () => {
  await fixture(async (root, output) => {
    const totalBytes = await syntheticTree(root);
    await writeLiteralArchive(root, output);
    const destination = join(output, '..', 'staged');
    const result = await materializeLiteralArchive(output, destination);
    assert.deepEqual(result, { sourcePlatform: process.platform, files: 2, directories: 2, symlinks: 0, totalBytes });
    assert.equal(await readFile(join(destination, 'settings.json'), 'utf8'), '{"synthetic":true}\n');
    assert.equal(await readFile(join(destination, 'nested', 'note.txt'), 'utf8'), 'synthetic note\n');
    assert.equal((await readdir(join(destination, 'nested'))).includes('empty'), true);
  });
});

test('refuses an existing staging destination and removes a partial one after cancellation', async () => {
  await fixture(async (root, output) => {
    await syntheticTree(root);
    await writeLiteralArchive(root, output);
    const existing = join(output, '..', 'existing');
    await mkdir(existing);
    await assert.rejects(materializeLiteralArchive(output, existing), { code: 'unsafe-path' });
    const aborted = join(output, '..', 'aborted');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(materializeLiteralArchive(output, aborted, { signal: controller.signal }), { code: 'aborted' });
    assert.equal(await lstat(aborted).then(() => true, () => false), false);
  });
});
