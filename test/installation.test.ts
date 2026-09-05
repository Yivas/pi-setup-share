import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activateImport, applyImport, installPackages, previewActivation, previewImport, previewInstallation, restoreImport, type InstallationPlan, type PackageInstallerFactory } from '../src/import.ts';
import { FileStore, StorageError } from '../src/storage.ts';
import { appliedTransactionsFor, recoverChanges } from '../src/transaction.ts';

const profile = { format: 'pi-setup-share', version: 1, resources: [], packages: [
  { source: 'npm:synthetic-one@1.2.3', autoload: false, extensions: [], skills: ['skills/**'], prompts: ['!prompts/private.md'] },
  { source: `git:https://example.com/team/synthetic@${'a'.repeat(40)}` },
] };
function base(id: string): string { return `setup-share/imports/${id}`; }
async function fixture(run: (root: string, store: FileStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-setup-share-installation-'));
  try { await run(root, await FileStore.open(root)); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}
async function stage(store: FileStore, value: unknown = profile): Promise<string> {
  const plan = await previewImport(store, value);
  await applyImport(store, plan, true);
  return plan.importId;
}
function fake(calls: string[] = []): PackageInstallerFactory {
  return directory => {
    const paths = new Map<string, string>();
    return {
      async install(source) {
        calls.push(source);
        const path = join(directory, 'npm/node_modules', `synthetic-${paths.size + 1}`);
        await mkdir(path, { recursive: true });
        await writeFile(join(path, 'package.json'), '{"private":true}\n');
        paths.set(source, path);
      },
      getInstalledPath(source, scope) { assert.equal(scope, 'user'); return paths.get(source); },
    };
  };
}

test('installation preview is immutable and read-only; refusal and pre-cancellation retain the plan', async () => {
  await fixture(async (root, store) => {
    const id = await stage(store);
    const before = await readdir(join(root, base(id)));
    const plan = await previewInstallation(store, id);
    assert.deepEqual(plan.sources, profile.packages.map(package_ => package_.source));
    assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.sources));
    assert.deepEqual(await readdir(join(root, base(id))), before);
    const calls: string[] = [];
    await assert.rejects(installPackages(store, plan, false, fake(calls)), { code: 'consent-required' });
    await assert.rejects(installPackages(store, plan, true, fake(calls), AbortSignal.abort()), { code: 'aborted' });
    assert.deepEqual(calls, []);
    assert.deepEqual(await readdir(join(root, base(id))), before);
    await installPackages(store, plan, true, fake(calls));
    assert.deepEqual(calls, plan.sources);
    await assert.rejects(installPackages(store, plan, true, fake()), { code: 'invalid-state' });
  });
});

test('installation plans are store-bound and cannot be forged', async () => {
  await fixture(async (root, store) => {
    const id = await stage(store);
    const plan = await previewInstallation(store, id);
    await assert.rejects(installPackages(store, { ...plan } as InstallationPlan, true, fake()), { code: 'invalid-state' });
    await assert.rejects(installPackages(await FileStore.open(root), plan, true, fake()), { code: 'invalid-state' });
    assert.equal((await readdir(join(root, base(id)))).includes('package-store'), false);
  });
});

test('installation records all local paths without activating or changing native configuration', async () => {
  await fixture(async (root, store) => {
    await writeFile(join(root, 'settings.json'), '{"packages":["./existing"],"keep":true}\n');
    const before = await readFile(join(root, 'settings.json'));
    const id = await stage(store);
    const factory: PackageInstallerFactory = directory => {
      assert.equal(directory, join(store.root, base(id), 'package-store'));
      return fake()(directory);
    };
    await installPackages(store, await previewInstallation(store, id), true, factory);
    assert.deepEqual(await readFile(join(root, 'settings.json')), before);
    const manifest = JSON.parse(await readFile(join(root, base(id), 'manifest.json'), 'utf8'));
    assert.equal(manifest.state, 'staged');
    assert.equal(manifest.installationReceipt.packageSources.length, 2);
    assert.equal((await appliedTransactionsFor(store, `${base(id)}/manifest.json`)).length, 2);
    assert.equal((await store.read('mcp.json')).bytes, null);
    await assert.rejects(previewInstallation(store, id), { code: 'invalid-state' });
  });
});

test('activation separately consents to local descriptors, preserving filters, false and absence', async () => {
  await fixture(async (root, store) => {
    const id = await stage(store);
    assert.equal((await previewActivation(store, id)).deferredPackages, 2);
    await installPackages(store, await previewInstallation(store, id), true, fake());
    const plan = await previewActivation(store, id);
    assert.equal(plan.deferredPackages, 0);
    assert.deepEqual(plan.items, [{ id: 'packages', status: 'new', action: 'write' }]);
    await assert.rejects(activateImport(store, plan, false), { code: 'consent-required' });
    assert.equal((await store.read('settings.json')).bytes, null);
    await activateImport(store, plan, true);
    const settings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.packages, profile.packages.map((package_, index) => ({ ...package_, source: `./${base(id)}/package-store/npm/node_modules/synthetic-${index + 1}` })));
    assert.equal(JSON.stringify(settings).includes('npm:'), false);
    assert.equal(JSON.stringify(settings).includes('https:'), false);
    assert.equal((await appliedTransactionsFor(store, `${base(id)}/manifest.json`)).length, 3);
  });
});

test('a partial SDK failure retains unregistered files, hides raw errors and forbids automatic retry', async () => {
  await fixture(async (root, store) => {
    const id = await stage(store);
    const before = await readFile(join(root, base(id), 'manifest.json'));
    const factory: PackageInstallerFactory = async directory => {
      const installer = await fake()(directory);
      let count = 0;
      return { ...installer, async install(source) {
        if (++count === 2) throw new Error('synthetic private command output');
        await installer.install(source);
      } };
    };
    await assert.rejects(installPackages(store, await previewInstallation(store, id), true, factory), { code: 'installation-abandoned', message: 'installation-abandoned' });
    assert.deepEqual(await readFile(join(root, base(id), 'manifest.json')), before);
    assert.equal((await store.read('settings.json')).bytes, null);
    assert.equal((await readFile(join(root, base(id), 'package-store/npm/node_modules/synthetic-1/package.json'), 'utf8')), '{"private":true}\n');
    await assert.rejects(previewInstallation(store, id), { code: 'installation-abandoned' });
    assert.equal((await previewActivation(store, id)).deferredPackages, 2);
  });
});

test('cancellation after an in-flight install stops later packages and leaves no receipt', async () => {
  await fixture(async (root, store) => {
    const id = await stage(store);
    const controller = new AbortController();
    const calls: string[] = [];
    const factory: PackageInstallerFactory = async directory => {
      const installer = await fake(calls)(directory);
      return { ...installer, async install(source) { await installer.install(source); controller.abort(); } };
    };
    await assert.rejects(installPackages(store, await previewInstallation(store, id), true, factory, controller.signal), { code: 'aborted' });
    assert.equal(calls.length, 1);
    assert.equal((await appliedTransactionsFor(store, `${base(id)}/manifest.json`)).length, 1);
    assert.equal((await store.read('settings.json')).bytes, null);
    await assert.rejects(previewInstallation(store, id), { code: 'installation-abandoned' });
    assert.ok((await readdir(join(root, base(id)))).includes('package-store'));
  });
});

test('an interrupted attempt marker is not reused, including a marker created after preview', async () => {
  await fixture(async (root, store) => {
    const id = await stage(store);
    const plan = await previewInstallation(store, id);
    await mkdir(join(root, base(id), 'package-store'));
    let called = false;
    await assert.rejects(installPackages(store, plan, true, () => { called = true; throw new Error(); }), { code: 'installation-abandoned' });
    assert.equal(called, false);
    await assert.rejects(previewInstallation(store, id), { code: 'installation-abandoned' });
  });
});

test('missing, external, relative and duplicate installed paths never produce receipts', async () => {
  for (const kind of ['missing', 'external', 'relative', 'duplicate'] as const) await fixture(async (root, store) => {
    const id = await stage(store);
    const factory: PackageInstallerFactory = async directory => {
      const installer = await fake()(directory);
      return { ...installer, getInstalledPath(source, scope) {
        if (kind === 'missing') return undefined;
        if (kind === 'external') return join(root, 'outside');
        if (kind === 'relative') return 'relative/path';
        return installer.getInstalledPath(profile.packages[0]!.source, scope);
      } };
    };
    await assert.rejects(installPackages(store, await previewInstallation(store, id), true, factory), { code: 'unsafe-path' });
    assert.equal((await appliedTransactionsFor(store, `${base(id)}/manifest.json`)).length, 1);
    assert.equal((await store.read('settings.json')).bytes, null);
  });
});

test('a linked installed directory is rejected before activation, including after preview', async () => {
  await fixture(async (root, store) => {
    const id = await stage(store);
    await installPackages(store, await previewInstallation(store, id), true, fake());
    const plan = await previewActivation(store, id);
    const path = join(root, base(id), 'package-store/npm/node_modules/synthetic-1');
    await rename(path, `${path}-saved`);
    await symlink(`${path}-saved`, path, 'junction');
    await assert.rejects(previewActivation(store, id), { code: 'unsafe-path' });
    await assert.rejects(activateImport(store, plan, true), { code: 'unsafe-path' });
    assert.equal((await store.read('settings.json')).bytes, null);
  });
});

test('stale activation plans and replayed staged manifests cannot hide an installation', async () => {
  await fixture(async (root, store) => {
    const id = await stage(store);
    const manifestPath = join(root, base(id), 'manifest.json');
    const staged = await readFile(manifestPath);
    const oldActivation = await previewActivation(store, id);
    await installPackages(store, await previewInstallation(store, id), true, fake());
    await assert.rejects(activateImport(store, oldActivation, true), { code: 'changed' });
    assert.equal((await store.read('settings.json')).bytes, null);
    await writeFile(manifestPath, staged);
    await assert.rejects(previewActivation(store, id), { code: 'changed' });
    await assert.rejects(restoreImport(store, id, true), { code: 'changed' });
  });
});

test('concurrent activation prevents a late installation receipt and does not register its packages', async () => {
  await fixture(async (root, store) => {
    const id = await stage(store);
    const activation = await previewActivation(store, id);
    const factory: PackageInstallerFactory = async directory => {
      await activateImport(store, activation, true);
      return fake()(directory);
    };
    await assert.rejects(installPackages(store, await previewInstallation(store, id), true, factory), { code: 'changed' });
    assert.equal((await store.read('settings.json')).bytes, null);
    const manifest = JSON.parse(await readFile(join(root, base(id), 'manifest.json'), 'utf8'));
    assert.equal(manifest.state, 'active');
    assert.equal(Object.hasOwn(manifest, 'installationReceipt'), false);
  });
});

test('agent and installed-package conflict decisions use one immutable native baseline', async () => {
  await fixture(async (root, store) => {
    const value = { ...profile, resources: [{ kind: 'agent', path: 'worker.md', encoding: 'utf8', content: 'Synthetic agent.' }], entrypoints: { agent: ['worker.md'] } };
    await writeFile(join(root, 'settings.json'), '{"packages":false}\n');
    const id = await stage(store, value);
    await installPackages(store, await previewInstallation(store, id), true, fake());
    const plan = await previewActivation(store, id, { resources: { 'resources.agent': 'overwrite' } });
    assert.deepEqual(plan.items, [
      { id: 'resources.agent', status: 'conflict', action: 'write' },
      { id: 'packages', status: 'conflict', action: 'preserve' },
    ]);
    await activateImport(store, plan, true);
    const settings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
    assert.equal(settings.packages.length, 1);
    assert.ok(settings.packages[0].source.endsWith('/agents-package'));
  });
});

test('agent and installed-package references both append to an initially absent package setting', async () => {
  await fixture(async (root, store) => {
    const value = { ...profile, resources: [{ kind: 'agent', path: 'worker.md', encoding: 'utf8', content: 'Synthetic agent.' }], entrypoints: { agent: ['worker.md'] } };
    const id = await stage(store, value);
    await installPackages(store, await previewInstallation(store, id), true, fake());
    const plan = await previewActivation(store, id);
    assert.deepEqual(plan.items, [
      { id: 'resources.agent', status: 'new', action: 'write' },
      { id: 'packages', status: 'new', action: 'write' },
    ]);
    await activateImport(store, plan, true);
    const settings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
    assert.equal(settings.packages.length, 3);
    assert.ok(settings.packages[0].source.endsWith('/agents-package'));
    assert.deepEqual(settings.packages.slice(1), profile.packages.map((package_, index) => ({ ...package_, source: `./${base(id)}/package-store/npm/node_modules/synthetic-${index + 1}` })));
  });
});

test('restore reverses activation and installation receipts, but deliberately retains package files', async () => {
  await fixture(async (root, store) => {
    await writeFile(join(root, 'settings.json'), '{"quietStartup":false}\n');
    const original = await readFile(join(root, 'settings.json'));
    const id = await stage(store);
    await installPackages(store, await previewInstallation(store, id), true, fake());
    await activateImport(store, await previewActivation(store, id), true);
    await restoreImport(store, id, true);
    assert.deepEqual(await readFile(join(root, 'settings.json')), original);
    assert.equal((await store.read(`${base(id)}/manifest.json`)).bytes, null);
    assert.equal((await store.read(`${base(id)}/profile.json`)).bytes, null);
    assert.equal((await appliedTransactionsFor(store, `${base(id)}/manifest.json`)).length, 0);
    assert.equal(await readFile(join(root, base(id), 'package-store/npm/node_modules/synthetic-1/package.json'), 'utf8'), '{"private":true}\n');
  });
});

test('interrupted three-step restoration recovers the entire chain without deleting package files', async t => {
  await fixture(async (root, store) => {
    const id = await stage(store);
    await installPackages(store, await previewInstallation(store, id), true, fake());
    await activateImport(store, await previewActivation(store, id), true);
    const original = store.remove.bind(store);
    let fail = true;
    t.mock.method(store, 'remove', async (...args: Parameters<FileStore['remove']>) => {
      if (args[0] === `${base(id)}/profile.json` && fail) { fail = false; throw new StorageError('unavailable'); }
      return original(...args);
    });
    await assert.rejects(restoreImport(store, id, true), { code: 'recovery-required' });
    assert.notEqual((await store.read('setup-share/pending.json')).bytes, null);
    await recoverChanges(store, true);
    assert.equal((await store.read('setup-share/pending.json')).bytes, null);
    assert.equal((await store.read(`${base(id)}/profile.json`)).bytes, null);
    assert.equal((await appliedTransactionsFor(store, `${base(id)}/manifest.json`)).length, 0);
    assert.ok((await readdir(join(root, base(id)))).includes('package-store'));
  });
});

test('altered receipt paths cannot reuse the same transaction identifiers', async () => {
  await fixture(async (root, store) => {
    const id = await stage(store);
    await installPackages(store, await previewInstallation(store, id), true, fake());
    const activation = await previewActivation(store, id);
    const path = join(root, base(id), 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.installationReceipt.packageSources.reverse();
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(previewActivation(store, id), { code: 'changed' });
    await assert.rejects(activateImport(store, activation, true), { code: 'changed' });
    await assert.rejects(restoreImport(store, id, true), { code: 'changed' });
    assert.equal((await store.read('settings.json')).bytes, null);
  });
});

test('later installations cannot invalidate an earlier directory and still record success', async () => {
  await fixture(async (root, store) => {
    const id = await stage(store);
    const factory: PackageInstallerFactory = async directory => {
      const installer = await fake()(directory);
      let count = 0;
      return { ...installer, async install(source) {
        await installer.install(source);
        if (++count === 2) await rm(join(directory, 'npm/node_modules/synthetic-1'), { recursive: true, force: true });
      } };
    };
    await assert.rejects(installPackages(store, await previewInstallation(store, id), true, factory), { code: 'unavailable' });
    assert.equal((await appliedTransactionsFor(store, `${base(id)}/manifest.json`)).length, 1);
    assert.equal((await store.read('settings.json')).bytes, null);
  });
});

test('the maximum package count fits a bounded installation receipt', async () => {
  await fixture(async (_root, store) => {
    const packages = Array.from({ length: 64 }, (_, index) => ({ source: `npm:synthetic-${index}@1.0.0` }));
    const id = await stage(store, { ...profile, packages });
    const plan = await previewInstallation(store, id);
    assert.equal(plan.sources.length, 64);
    await installPackages(store, plan, true, fake());
    assert.equal((await previewActivation(store, id)).deferredPackages, 0);
  });
});
