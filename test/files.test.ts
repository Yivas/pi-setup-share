import assert from 'node:assert/strict';
import { appendFile, link, mkdir, mkdtemp, open, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverResources, exportResources, ResourceReadError } from '../src/files.ts';
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
    // Size the fixture from the constants: whole per-file payloads that exactly fill the aggregate, plus one more.
    const fitting = Math.floor(PROFILE_LIMITS.totalBytes / PROFILE_LIMITS.fileBytes);
    const selection = [];
    for (let index = 0; index < fitting + 1; index++) {
      const path = `file-${index}.txt`;
      await writeFile(join(root, path), Buffer.alloc(PROFILE_LIMITS.fileBytes, 120));
      selection.push({ kind: 'prompt' as const, path });
    }
    assert.equal((await exportResources(root, selection.slice(0, fitting))).length, fitting);
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
  for (const path of ['auth.json', 'nested/TRUST.json', 'settings.json', 'keybindings.json', 'models.json', 'mcp.json', '.env', 'nested/.ENV.local', '.npmrc', 'nested/CREDENTIALS.json', '.aws/credentials', '.ssh/id_rsa', 'id_ecdsa', 'nested/ID_ECDSA', 'id_ed25519_sk', 'credentials/current.md', 'secrets/current.md', 'sessions/session.json', 'log.log', 'events.jsonl', 'node_modules/package/index.js']) {
    await assert.rejects(exportResources(join(tmpdir(), 'not-created-synthetic-root'), [{ kind: 'extension', path }]), ProfileError);
  }
});

test('manual roots inside known operational directories cannot bypass path exclusions', async () => {
  await fixture(async parent => {
    for (const name of ['sessions', 'credentials', 'secrets']) {
      const root = join(parent, name);
      await mkdir(root);
      await writeFile(join(root, 'current.md'), 'synthetic operational marker');
      await assert.rejects(exportResources(root, [{ kind: 'prompt', path: 'current.md' }]), { code: 'invalid-path' });
      await assert.rejects(discoverResources(root, 'prompt'), { code: 'invalid-path' });
    }
  });
});

test('discovers bounded local candidates without reading their contents', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'my-skill'));
    await writeFile(join(root, 'my-skill', 'SKILL.md'), 'synthetic-skill-sentinel');
    await writeFile(join(root, 'my-skill', 'support.ts'), 'synthetic-support-sentinel');
    await writeFile(join(root, 'my-skill', '.env'), 'synthetic-secret-sentinel');
    const result = await discoverResources(root, 'skill');
    assert.deepEqual(result.candidates.map(candidate => [candidate.path, candidate.entrypoint]),
      [['my-skill/SKILL.md', true], ['my-skill/support.ts', false]]);
    assert.equal(result.omitted, 1);
    assert.equal(JSON.stringify(result).includes('synthetic-secret-sentinel'), false);
  });
});

test('does not follow links, scan nested prompt templates, or ignore inventory limits', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'main.md'), 'synthetic');
    await writeFile(join(root, 'nested', 'hidden.md'), 'synthetic');
    await symlink(join(root, 'nested'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await discoverResources(root, 'prompt');
    assert.deepEqual(result.candidates.map(candidate => candidate.path), ['main.md']);
    assert.ok(result.omitted >= 2);
    for (let index = 0; index < 4; index++) await writeFile(join(root, `${index}.md`), 'synthetic');
    const bounded = await discoverResources(root, 'prompt', undefined, 3);
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.candidates.length <= 3);
  });
});

test('cooperative inventory deadline reports partial coverage', async t => {
  await fixture(async root => {
    await writeFile(join(root, 'sample.ts'), 'synthetic');
    let ticks = 0;
    t.mock.method(Date, 'now', () => ++ticks * 6_000);
    const result = await discoverResources(root, 'extension');
    t.mock.restoreAll();
    assert.equal(result.truncated, true);
    assert.deepEqual(result.candidates, []);
  });
});

test('offers at most the profile limit of candidates without failing the entire inventory', async () => {
  await fixture(async root => {
    await Promise.all(Array.from({ length: PROFILE_LIMITS.resources + 1 }, (_, index) => writeFile(join(root, `extension-${index}.ts`), 'synthetic')));
    const result = await discoverResources(root, 'extension');
    // The inventory stays bounded and reports truncation. Which bound trips first (candidate count or traversal
    // visits) is an implementation detail, so the test only pins the guarantee: a bounded list, never an error.
    assert.ok(result.candidates.length > 0);
    assert.ok(result.candidates.length <= PROFILE_LIMITS.resources);
    assert.equal(result.truncated, true);
  });
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
