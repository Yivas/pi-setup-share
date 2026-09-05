import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readProfileFile, writeProfileFile } from '../src/profile-file.ts';
import { PROFILE_LIMITS } from '../src/profile.ts';

const profile = { format: 'pi-setup-share', version: 1, resources: [] };
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-setup-share-profile-'));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

test('writes a selected profile exclusively and reads it without side effects', async () => {
  await fixture(async root => {
    const path = join(root, 'portable.json');
    await writeProfileFile(path, profile, true);
    assert.deepEqual(await readProfileFile(path), profile);
    assert.deepEqual(await readdir(root), ['portable.json']);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test('refusal and pre-cancellation create nothing', async () => {
  await fixture(async root => {
    const signal = AbortSignal.abort();
    await assert.rejects(writeProfileFile(join(root, 'profile.json'), profile, false), { code: 'consent-required' });
    await assert.rejects(writeProfileFile(join(root, 'profile.json'), profile, true, signal), { code: 'aborted' });
    await assert.rejects(readProfileFile(join(root, 'profile.json'), signal), { code: 'aborted' });
    assert.deepEqual(await readdir(root), []);
  });
});

test('concurrent exports never replace an existing destination', async () => {
  await fixture(async root => {
    const path = join(root, 'profile.json');
    const results = await Promise.allSettled([writeProfileFile(path, profile, true), writeProfileFile(path, profile, true)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.deepEqual(await readProfileFile(path), profile);
    await writeFile(path, 'existing work');
    await assert.rejects(writeProfileFile(path, profile, true), { code: 'changed' });
    assert.equal(await readFile(path, 'utf8'), 'existing work');
  });
});

test('rejects invalid profiles before creating output', async () => {
  await fixture(async root => {
    await assert.rejects(writeProfileFile(join(root, 'profile.json'), { ...profile, version: 99 }, true));
    assert.deepEqual(await readdir(root), []);
  });
});

test('rejects nonregular files, hardlinks, oversized files and invalid UTF-8', async () => {
  await fixture(async root => {
    const path = join(root, 'profile.json');
    await mkdir(join(root, 'directory.json'));
    await assert.rejects(readProfileFile(join(root, 'directory.json')), { code: 'unsafe-path' });
    await writeFile(path, JSON.stringify(profile));
    await link(path, join(root, 'linked.json'));
    await assert.rejects(readProfileFile(path), { code: 'unsafe-path' });
    await rm(join(root, 'linked.json'));
    await writeFile(path, Buffer.alloc(PROFILE_LIMITS.jsonBytes + 1, 32));
    await assert.rejects(readProfileFile(path), { code: 'limit-exceeded' });
    await writeFile(path, Buffer.from([0xff]));
    await assert.rejects(readProfileFile(path), { code: 'invalid-state' });
  });
});

test('rejects operational names and relative paths before reading', async () => {
  for (const path of ['profile.json', '//server/share/profile.json', '/synthetic/auth.json', '/synthetic/.env', '/synthetic/sessions/profile.json']) {
    await assert.rejects(readProfileFile(path), { code: 'unsafe-path' });
  }
});

test('cancellation during exclusive open rejects and leaves the reserved file empty', async () => {
  await fixture(async root => {
    const controller = new AbortController();
    let checks = 0;
    const signal = { get aborted() {
      if (++checks === 2) queueMicrotask(() => controller.abort());
      return controller.signal.aborted;
    } } as AbortSignal;
    const path = join(root, 'profile.json');
    await assert.rejects(writeProfileFile(path, profile, true, signal), { code: 'aborted' });
    assert.equal((await stat(path)).size, 0);
  });
});

test('filesystem errors contain no selected path', async () => {
  await fixture(async root => {
    await assert.rejects(readProfileFile(join(root, 'missing.json')), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'unavailable');
      assert.equal(JSON.stringify(error).includes(root), false);
      return true;
    });
  });
});
