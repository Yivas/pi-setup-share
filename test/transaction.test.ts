import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appliedTransactionsFor, commitChanges, recoverChanges, restoreChanges, restoreChain, type FileChange } from '../src/transaction.ts';
import { FileStore, StorageError, type FileSnapshot } from '../src/storage.ts';

async function fixture(run: (root: string, store: FileStore, changes: FileChange[]) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-setup-share-tx-'));
  try {
    const store = await FileStore.open(root);
    const changes = [];
    for (const path of ['settings.json', 'keybindings.json']) {
      await writeFile(join(root, path), `before ${path}`);
      changes.push({ path, bytes: Buffer.from(`after ${path}`), before: await store.read(path) });
    }
    await run(root, store, changes);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

async function assertOriginal(root: string): Promise<void> {
  for (const path of ['settings.json', 'keybindings.json']) assert.equal(await readFile(join(root, path), 'utf8'), `before ${path}`);
}

test('requires literal consent and rejects destinations outside the managed allowlist', async () => {
  await fixture(async (root, store, changes) => {
    await assert.rejects(commitChanges(store, changes, false), { code: 'consent-required' });
    await assert.rejects(commitChanges(store, [{ ...(changes[0] as FileChange), path: 'auth.json' }], true), { code: 'invalid-state' });
    assert.deepEqual((await readdir(root)).sort(), ['keybindings.json', 'settings.json']);
    await assertOriginal(root);
  });
});

test('rejects mismatched backup bytes before creating managed storage', async () => {
  await fixture(async (root, store, changes) => {
    const change = changes[0] as FileChange;
    await assert.rejects(commitChanges(store, [{ ...change, before: { ...change.before, bytes: Buffer.from('wrong backup') } }], true), { code: 'invalid-state' });
    await assertOriginal(root);
    assert.deepEqual((await readdir(root)).sort(), ['keybindings.json', 'settings.json']);
  });
});

test('commits and restores managed bytes through a retained backup', async () => {
  await fixture(async (root, store, changes) => {
    const id = await commitChanges(store, changes, true);
    assert.ok(id);
    assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), 'after settings.json');
    const journal = JSON.parse(await readFile(join(root, 'setup-share', 'backups', `${id}.json`), 'utf8'));
    assert.equal(journal.state, 'applied');
    await assert.rejects(restoreChanges(store, id, false), { code: 'consent-required' });
    await restoreChanges(store, id, true);
    await assertOriginal(root);
    assert.equal(JSON.parse(await readFile(join(root, 'setup-share', 'backups', `${id}.json`), 'utf8')).state, 'restored');
    assert.equal((await store.read('setup-share/pending.json')).bytes, null);
  });
});

test('rejects stale preview before writing any selected destination', async () => {
  await fixture(async (root, store, changes) => {
    await writeFile(join(root, 'settings.json'), 'subsequent work');
    await assert.rejects(commitChanges(store, changes, true), { code: 'changed' });
    assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), 'subsequent work');
    assert.equal(await readFile(join(root, 'keybindings.json'), 'utf8'), 'before keybindings.json');
    assert.equal((await store.read('setup-share/pending.json')).bytes, null);
  });
});

test('rolls back the first replacement when the second write fails', async t => {
  await fixture(async (root, store, changes) => {
    const original = store.write.bind(store);
    t.mock.method(store, 'write', async (path: string, bytes: Uint8Array, before: FileSnapshot) => {
      if (path === 'keybindings.json') throw new StorageError('unavailable');
      return original(path, bytes, before);
    });
    await assert.rejects(commitChanges(store, changes, true), { code: 'unavailable' });
    await assertOriginal(root);
    assert.equal((await store.read('setup-share/pending.json')).bytes, null);
    const names = await readdir(join(root, 'setup-share', 'backups'));
    assert.equal(JSON.parse(await readFile(join(root, 'setup-share', 'backups', names[0] as string), 'utf8')).state, 'rolled-back');
  });
});

test('retains a recovery gate after rollback failure and repairs only known writes', async t => {
  await fixture(async (root, store, changes) => {
    const original = store.write.bind(store);
    t.mock.method(store, 'write', async (path: string, bytes: Uint8Array, before: FileSnapshot) => {
      if (path === 'keybindings.json' || (path === 'settings.json' && Buffer.from(bytes).toString() === 'before settings.json')) throw new StorageError('unavailable');
      return original(path, bytes, before);
    });
    await assert.rejects(commitChanges(store, changes, true), { code: 'recovery-required' });
    t.mock.restoreAll();
    await assert.rejects(commitChanges(store, [], true), { code: 'recovery-required' });
    await recoverChanges(store, true);
    await assertOriginal(root);
    assert.equal((await store.read('setup-share/pending.json')).bytes, null);
  });
});

test('restore preflights all destinations and preserves later user edits', async () => {
  await fixture(async (root, store, changes) => {
    const id = await commitChanges(store, changes, true);
    assert.ok(id);
    await writeFile(join(root, 'settings.json'), 'subsequent work');
    await assert.rejects(restoreChanges(store, id, true), { code: 'changed' });
    assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), 'subsequent work');
    assert.equal(await readFile(join(root, 'keybindings.json'), 'utf8'), 'after keybindings.json');
    assert.equal((await store.read('setup-share/pending.json')).bytes, null);
  });
});

test('a second transaction cannot acquire or remove another writer lock', async t => {
  await fixture(async (root, store, changes) => {
    const original = store.write.bind(store);
    let enter: () => void = () => {};
    let resume: () => void = () => {};
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    t.mock.method(store, 'write', async (path: string, bytes: Uint8Array, before: FileSnapshot) => {
      if (path === 'settings.json') { enter(); await gate; }
      return original(path, bytes, before);
    });
    const first = commitChanges(store, changes, true);
    await entered;
    try {
      await assert.rejects(commitChanges(store, changes, true), { code: 'busy' });
      assert.ok((await readdir(join(root, 'setup-share'))).includes('lock'));
    } finally { resume(); }
    assert.ok(await first);
    assert.equal((await readdir(join(root, 'setup-share'))).includes('lock'), false);
  });
});

test('cancellation during apply rolls back rather than cancelling recovery', async t => {
  await fixture(async (root, store, changes) => {
    const controller = new AbortController();
    const original = store.write.bind(store);
    t.mock.method(store, 'write', async (path: string, bytes: Uint8Array, before: FileSnapshot) => {
      const result = await original(path, bytes, before);
      if (path === 'settings.json') controller.abort('not exposed');
      return result;
    });
    await assert.rejects(commitChanges(store, changes, true, controller.signal), { code: 'aborted' });
    await assertOriginal(root);
  });
});

test('restores an ordered chain even though earlier owned bytes get new filesystem identities', async () => {
  await fixture(async (root, store, changes) => {
    const first = await commitChanges(store, changes, true);
    const second = await commitChanges(store, [{ path: 'settings.json', bytes: Buffer.from('second import'), before: await store.read('settings.json') }], true);
    assert.ok(first && second);
    await restoreChain(store, [second, first], true);
    await assertOriginal(root);
  });
});

test('keeps the entire reverse chain recoverable between steps', async t => {
  await fixture(async (root, store, changes) => {
    const first = await commitChanges(store, changes, true);
    const second = await commitChanges(store, [{ path: 'settings.json', bytes: Buffer.from('second import'), before: await store.read('settings.json') }], true);
    assert.ok(first && second);
    const original = store.write.bind(store);
    let writes = 0;
    t.mock.method(store, 'write', async (path: string, bytes: Uint8Array, before: FileSnapshot) => {
      if (path === 'setup-share/pending.json' && ++writes === 2) throw new StorageError('unavailable');
      return original(path, bytes, before);
    });
    await assert.rejects(restoreChain(store, [second, first], true));
    t.mock.restoreAll();
    await assert.rejects(commitChanges(store, [], true), { code: 'recovery-required' });
    await recoverChanges(store, true);
    await assertOriginal(root);
    assert.equal((await store.read('setup-share/pending.json')).bytes, null);
  });
});

test('preflights the oldest transaction before changing the newest one', async () => {
  await fixture(async (root, store, changes) => {
    const first = await commitChanges(store, changes, true);
    const second = await commitChanges(store, [{ path: 'settings.json', bytes: Buffer.from('second import'), before: await store.read('settings.json') }], true);
    assert.ok(first && second);
    await writeFile(join(root, 'keybindings.json'), 'subsequent work');
    await assert.rejects(restoreChain(store, [second, first], true), { code: 'changed' });
    assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), 'second import');
    assert.equal(await readFile(join(root, 'keybindings.json'), 'utf8'), 'subsequent work');
    assert.equal((await store.read('setup-share/pending.json')).bytes, null);
  });
});

test('rejects altered backup destinations before any restore write', async () => {
  await fixture(async (root, store, changes) => {
    const id = await commitChanges(store, changes, true);
    assert.ok(id);
    const path = join(root, 'setup-share', 'backups', `${id}.json`);
    const journal = JSON.parse(await readFile(path, 'utf8'));
    journal.entries[0].path = 'auth.json';
    await writeFile(path, JSON.stringify(journal));
    await assert.rejects(restoreChanges(store, id, true), { code: 'invalid-state' });
    assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), 'after settings.json');
  });
});

test('does not take over unowned managed-name directories', async () => {
  await fixture(async (root, store, changes) => {
    await mkdir(join(root, 'setup-share'));
    await writeFile(join(root, 'setup-share', 'user-file.txt'), 'synthetic');
    await assert.rejects(commitChanges(store, changes, true), { code: 'invalid-state' });
    assert.deepEqual(await readdir(join(root, 'setup-share')), ['user-file.txt']);
    await assertOriginal(root);
  });
});

test('applied-history inspection rejects linked backup directories', async () => {
  await fixture(async (root, store, changes) => {
    await commitChanges(store, changes, true);
    const backups = join(root, 'setup-share', 'backups');
    const actual = join(root, 'actual-backups');
    await rename(backups, actual);
    await symlink(actual, backups, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(appliedTransactionsFor(store, 'settings.json'), { code: 'unsafe-path' });
  });
});

test('applied-history inspection bounds even unrelated directory entries', async () => {
  await fixture(async (root, store, changes) => {
    await commitChanges(store, changes, true);
    for (let index = 0; index < 4096; index++) await writeFile(join(root, 'setup-share', 'backups', `extra-${index}.txt`), '');
    await assert.rejects(appliedTransactionsFor(store, 'settings.json'), { code: 'limit-exceeded' });
  });
});

test('applied-history inspection caps aggregate journal bytes before the next read', async () => {
  await fixture(async (root, store, changes) => {
    const first = await commitChanges(store, changes, true);
    const second = await commitChanges(store, [{ path: 'settings.json', bytes: Buffer.from('second value'), before: await store.read('settings.json') }], true);
    assert.ok(first && second);
    assert.deepEqual(new Set(await appliedTransactionsFor(store, 'settings.json')), new Set([first, second]));
    for (const id of [first, second]) {
      const path = join(root, 'setup-share', 'backups', `${id}.json`);
      const journal = await readFile(path, 'utf8');
      await writeFile(path, journal + ' '.repeat(16 * 1024 * 1024));
    }
    await assert.rejects(appliedTransactionsFor(store, 'settings.json'), { code: 'limit-exceeded' });
  });
});

test('removes stale empty locks only after separate explicit confirmation', async () => {
  await fixture(async (root, store, changes) => {
    await commitChanges(store, changes, true);
    await mkdir(join(root, 'setup-share', 'lock'));
    await assert.rejects(recoverChanges(store, true), { code: 'busy' });
    await recoverChanges(store, true, true);
    assert.equal((await readdir(join(root, 'setup-share'))).includes('lock'), false);
    assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), 'after settings.json');
  });
});
