import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activateImport, applyImport, inspectImport, installPackages, listImports, previewActivation, previewImport, previewInstallation, restoreImport } from '../src/import.ts';
import { FileStore } from '../src/storage.ts';

const profile = { format: 'pi-setup-share', version: 1, resources: [], preferences: { quietStartup: true } };
async function fixture(run: (root: string, store: FileStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-setup-share-status-'));
  try { await run(root, await FileStore.open(root)); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

test('empty discovery creates nothing', async () => {
  await fixture(async (root, store) => {
    assert.deepEqual(await listImports(store), []);
    assert.deepEqual(await readdir(root), []);
  });
});

test('discovers imports and derives verified status without exposing profile data', async () => {
  await fixture(async (_root, store) => {
    const plan = await previewImport(store, profile);
    await applyImport(store, plan, true);
    assert.deepEqual(await listImports(store), [plan.importId]);
    assert.deepEqual(await inspectImport(store, plan.importId), { importId: plan.importId, state: 'staged', resources: 0, packages: 0 });
    await activateImport(store, await previewActivation(store, plan.importId), true);
    assert.equal((await inspectImport(store, plan.importId)).state, 'active');
    await restoreImport(store, plan.importId, true);
    assert.deepEqual(await listImports(store), []);
  });
});

test('detects an abandoned install without offering an automatic retry', async () => {
  await fixture(async (root, store) => {
    const plan = await previewImport(store, profile);
    await applyImport(store, plan, true);
    await mkdir(join(root, 'setup-share/imports', plan.importId, 'package-store'));
    assert.equal((await inspectImport(store, plan.importId)).state, 'installation-abandoned');
  });
});

test('unrelated discovery files do not hide imports', async () => {
  await fixture(async (root, store) => {
    const plan = await previewImport(store, profile);
    await applyImport(store, plan, true);
    await writeFile(join(root, 'setup-share/imports/discovery.json'), 'synthetic');
    assert.deepEqual(await listImports(store), [plan.importId]);
  });
});

test('status rejects missing staged payloads', async () => {
  await fixture(async (root, store) => {
    const plan = await previewImport(store, { ...profile, resources: [{ kind: 'prompt', path: 'example.md', encoding: 'utf8', content: 'synthetic' }] });
    await applyImport(store, plan, true);
    await rm(join(root, 'setup-share/imports', plan.importId, 'resources/prompt/example.md'));
    await assert.rejects(inspectImport(store, plan.importId), { code: 'changed' });
  });
});

test('status rejects missing installed package directories', async () => {
  await fixture(async (root, store) => {
    const plan = await previewImport(store, { ...profile, packages: [{ source: 'npm:example@1.2.3' }] });
    await applyImport(store, plan, true);
    let installed = '';
    await installPackages(store, await previewInstallation(store, plan.importId), true, packageStore => {
      installed = join(packageStore, 'example');
      return { install: async () => { await mkdir(installed); }, getInstalledPath: () => installed };
    });
    assert.equal((await inspectImport(store, plan.importId)).state, 'installed');
    await rm(installed, { recursive: true });
    await assert.rejects(inspectImport(store, plan.importId), { code: 'unavailable' });
  });
});

test('discovery limits available manifests before returning a list', async () => {
  await fixture(async (root, store) => {
    for (let index = 0; index < 129; index++) {
      const path = join(root, 'setup-share/imports', randomUUID());
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'manifest.json'), '{}');
    }
    await assert.rejects(listImports(store), { code: 'limit-exceeded' });
  });
});

test('status revalidates discovered manifests and blocks recovery before enumeration', async () => {
  await fixture(async (root, store) => {
    const plan = await previewImport(store, profile);
    await applyImport(store, plan, true);
    const path = join(root, 'setup-share/imports', plan.importId, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...manifest, profileHash: '0'.repeat(64) }));
    await assert.rejects(inspectImport(store, plan.importId), { code: 'changed' });
    await writeFile(join(root, 'setup-share/pending.json'), '{}');
    await assert.rejects(listImports(store), { code: 'recovery-required' });
    await assert.rejects(inspectImport(store, plan.importId), { code: 'recovery-required' });
  });
});
