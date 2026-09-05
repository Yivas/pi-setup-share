import assert from 'node:assert/strict';
import { appendFile, link, mkdir, mkdtemp, open, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportResources, ResourceReadError } from '../src/files.ts';
import { parseProfile, PROFILE_LIMITS, ProfileError } from '../src/profile.ts';

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-setup-share-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

test('reads only explicit text and binary selections without executing source', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'example.ts'), 'throw new Error("do not execute");');
    await writeFile(join(root, 'binary.bin'), Buffer.from([0xff, 0, 0x80]));
    await writeFile(join(root, 'unselected.txt'), 'not exported');
    const resources = await exportResources(root, [{ kind: 'extension', path: 'nested/example.ts' }, { kind: 'theme', path: 'binary.bin' }]);
    assert.equal(resources.length, 2);
    assert.equal(resources[0]?.encoding, 'utf8');
    assert.equal(resources[1]?.encoding, 'base64');
    assert.deepEqual(Buffer.from(resources[1]?.content ?? '', 'base64'), Buffer.from([0xff, 0, 0x80]));
    assert.equal(JSON.stringify(resources).includes('not exported'), false);
    assert.deepEqual(parseProfile(JSON.stringify({ format: 'pi-setup-share', version: 1, resources })).resources, resources);
  });
});

test('validates all paths and collisions before filesystem access', async () => {
  for (const selection of [[{ kind: 'prompt', path: '../escape' }], [{ kind: 'prompt', path: 'a' }, { kind: 'prompt', path: 'A' }]]) {
    await assert.rejects(exportResources(join(tmpdir(), 'not-created-synthetic-root'), selection as Parameters<typeof exportResources>[1]), ProfileError);
  }
  await assert.rejects(exportResources('.', []), ProfileError);
});

test('rejects missing files and directories without disclosing local paths', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'directory'));
    for (const path of ['missing', 'directory']) {
      await assert.rejects(exportResources(root, [{ kind: 'prompt', path }]), (error: unknown) => {
        assert.ok(error instanceof ResourceReadError);
        assert.equal(error.field, 'resources[0]');
        assert.equal(String(error).includes(root), false);
        assert.equal(JSON.stringify(error).includes(root), false);
        return true;
      });
    }
  });
});

test('rejects directory links and linked roots, including Windows junctions', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'actual'));
    await writeFile(join(root, 'actual', 'file.txt'), 'synthetic');
    await symlink(join(root, 'actual'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(exportResources(root, [{ kind: 'prompt', path: 'linked/file.txt' }]), { code: 'link' });
    await assert.rejects(exportResources(join(root, 'linked'), [{ kind: 'prompt', path: 'file.txt' }]), { code: 'link' });
  });
});

test('rejects hardlinked files', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'original.txt'), 'synthetic');
    await link(join(root, 'original.txt'), join(root, 'linked.txt'));
    await assert.rejects(exportResources(root, [{ kind: 'prompt', path: 'linked.txt' }]), { code: 'link' });
  });
});

test('rejects file symlinks when supported by the test host', async t => {
  await fixture(async root => {
    await writeFile(join(root, 'original.txt'), 'synthetic');
    try { await symlink(join(root, 'original.txt'), join(root, 'linked.txt'), 'file'); }
    catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Windows file symlinks require host permission; junction and hardlink tests still run.');
        return;
      }
      throw error;
    }
    await assert.rejects(exportResources(root, [{ kind: 'prompt', path: 'linked.txt' }]), { code: 'link' });
  });
});

test('enforces individual and aggregate decoded limits', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'large.txt'), Buffer.alloc(PROFILE_LIMITS.fileBytes + 1, 120));
    await assert.rejects(exportResources(root, [{ kind: 'prompt', path: 'large.txt' }]), { code: 'limit-exceeded' });
    const selection = [];
    for (let index = 0; index < 9; index++) {
      const path = `file-${index}.txt`;
      await writeFile(join(root, path), Buffer.alloc(PROFILE_LIMITS.fileBytes, 120));
      selection.push({ kind: 'prompt' as const, path });
    }
    assert.equal((await exportResources(root, selection.slice(0, 8))).length, 8);
    await assert.rejects(exportResources(root, selection), { code: 'limit-exceeded' });
  });
});

test('bounds escaped serialized JSON separately from decoded content', async () => {
  await fixture(async root => {
    const selection = [];
    for (let index = 0; index < 3; index++) {
      const path = `file-${index}.txt`;
      await writeFile(join(root, path), Buffer.alloc(PROFILE_LIMITS.fileBytes));
      selection.push({ kind: 'prompt' as const, path });
    }
    await assert.rejects(exportResources(root, selection), { code: 'limit-exceeded' });
  });
});

test('rejects known operational files even when explicitly selected', async () => {
  for (const path of ['auth.json', 'nested/TRUST.json', 'settings.json', 'keybindings.json', 'models.json', 'mcp.json', 'sessions/session.json', 'log.log', 'events.jsonl', 'node_modules/package/index.js']) {
    await assert.rejects(exportResources(join(tmpdir(), 'not-created-synthetic-root'), [{ kind: 'extension', path }]), ProfileError);
  }
});

test('detects growth during reading and closes the resource handle', async t => {
  await fixture(async root => {
    const path = join(root, 'example.txt');
    await writeFile(path, 'synthetic');
    const probe = await open(path, 'r');
    const prototype = Object.getPrototypeOf(probe);
    const original = probe.read;
    await probe.close();
    let changed = false;
    let resourceHandle: FileHandle | undefined;
    t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: unknown[]) {
      resourceHandle = this;
      const result = await Reflect.apply(original, this, args);
      if (!changed) { changed = true; await appendFile(path, ' changed'); }
      return result;
    });
    await assert.rejects(exportResources(root, [{ kind: 'prompt', path: 'example.txt' }]), { code: 'changed' });
    t.mock.restoreAll();
    assert.ok(resourceHandle);
    await assert.rejects(resourceHandle.stat(), { code: 'EBADF' });
    assert.equal((await exportResources(root, [{ kind: 'prompt', path: 'example.txt' }]))[0]?.content, 'synthetic changed');
  });
});

test('honors cancellation before I/O without exposing abort reasons', async () => {
  const controller = new AbortController();
  controller.abort('synthetic-secret');
  await assert.rejects(exportResources(join(tmpdir(), 'not-created-synthetic-root'), [], controller.signal), (error: unknown) => {
    assert.ok(error instanceof ResourceReadError);
    assert.equal(error.code, 'aborted');
    assert.equal(JSON.stringify(error).includes('synthetic-secret'), false);
    return true;
  });
});
