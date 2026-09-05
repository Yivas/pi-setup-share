import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileStore, StorageError, type FileSnapshot } from '../src/storage.ts';

async function fixture(run: (root: string, store: FileStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-setup-share-store-'));
  try { await run(root, await FileStore.open(root)); } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

test('snapshots absent files without creating directories', async () => {
  await fixture(async (root, store) => {
    assert.deepEqual(await store.read('missing/file.json'), { bytes: null, hash: null, signature: null });
    assert.deepEqual(await readdir(root), []);
  });
});

test('writes and replaces atomically with expected snapshots and no remaining temporaries', async () => {
  await fixture(async (root, store) => {
    const absent = await store.read('nested/file.json');
    const first = await store.write('nested/file.json', Buffer.from('first'), absent);
    assert.equal(first.bytes?.toString(), 'first');
    const second = await store.write('nested/file.json', Buffer.from('second'), first);
    assert.equal((await readFile(join(root, 'nested', 'file.json'))).toString(), 'second');
    assert.deepEqual(await readdir(join(root, 'nested')), ['file.json']);
    await store.remove('nested/file.json', second);
    assert.deepEqual(await readdir(join(root, 'nested')), []);
  });
});

test('does not overwrite or remove changes made after the snapshot', async () => {
  await fixture(async (root, store) => {
    await writeFile(join(root, 'settings.json'), 'before');
    const before = await store.read('settings.json');
    await writeFile(join(root, 'settings.json'), 'subsequent work');
    await assert.rejects(store.write('settings.json', Buffer.from('import'), before), { code: 'changed' });
    await assert.rejects(store.remove('settings.json', before), { code: 'changed' });
    assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), 'subsequent work');
  });
});

test('rejects traversal, nonregular files and links under the selected root', async () => {
  await fixture(async (root, store) => {
    for (const path of ['../outside', '/absolute', 'CON', 'a\\b', 'a/../b']) {
      await assert.rejects(store.read(path), StorageError);
    }
    await mkdir(join(root, 'actual'));
    await symlink(join(root, 'actual'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.read('linked/file.json'), { code: 'unsafe-path' });
    await assert.rejects(store.directory('linked/child'), { code: 'unsafe-path' });
    await assert.rejects(store.read('actual'), { code: 'unsafe-path' });
    await writeFile(join(root, 'file.json'), 'synthetic');
    await link(join(root, 'file.json'), join(root, 'hardlink.json'));
    await assert.rejects(store.read('hardlink.json'), { code: 'unsafe-path' });
  });
});

test('bounds reads and keeps raw filesystem error paths out of diagnostics', async () => {
  await fixture(async (root, store) => {
    await writeFile(join(root, 'file.json'), '12345');
    await assert.rejects(store.read('file.json', 4), { code: 'limit-exceeded' });
    await assert.rejects(FileStore.open(join(root, 'missing')), (error: unknown) => {
      assert.ok(error instanceof StorageError);
      assert.equal(JSON.stringify(error).includes(root), false);
      return true;
    });
  });
});

test('rechecks concurrency after creating a temporary and cleans up on rejection', async t => {
  await fixture(async (root, store) => {
    await writeFile(join(root, 'settings.json'), 'before');
    const before = await store.read('settings.json');
    const original = store.matches.bind(store);
    let calls = 0;
    t.mock.method(store, 'matches', async (path: string, expected: FileSnapshot) => {
      if (++calls === 2) await writeFile(join(root, 'settings.json'), 'subsequent work');
      return original(path, expected);
    });
    await assert.rejects(store.write('settings.json', Buffer.from('import'), before), { code: 'changed' });
    assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), 'subsequent work');
    assert.deepEqual(await readdir(root), ['settings.json']);
  });
});
