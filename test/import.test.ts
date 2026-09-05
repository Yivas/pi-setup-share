import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { activateImport, applyImport, previewActivation, previewImport, restoreImport, type StagingPlan } from '../src/import.ts';
import { FileStore, StorageError, type FileSnapshot } from '../src/storage.ts';
import { recoverChanges } from '../src/transaction.ts';

const empty = { format: 'pi-setup-share', version: 1, resources: [] };
const profile = { ...empty,
  resources: [
    { kind: 'extension', path: 'main.ts', encoding: 'utf8', content: 'throw new Error("synthetic resource must not execute");' },
    { kind: 'extension', path: 'support.ts', encoding: 'utf8', content: 'synthetic support' },
    { kind: 'prompt', path: 'example.md', encoding: 'utf8', content: 'Synthetic prompt' },
  ],
  entrypoints: { extension: ['main.ts'], prompt: ['example.md'] },
  preferences: { quietStartup: true },
  keybindings: { 'app.interrupt': [] },
};
async function fixture(run: (root: string, store: FileStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-setup-share-import-'));
  try { await run(root, await FileStore.open(root)); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}
function base(id: string): string { return `setup-share/imports/${id}`; }
async function native(root: string): Promise<void> {
  await writeFile(join(root, 'settings.json'), '{"quietStartup":false,"extensions":["./existing.ts"],"unrelated":{"keep":true}}\n');
  await writeFile(join(root, 'keybindings.json'), '{"app.interrupt":["escape"]}\n');
}

test('staging preview is read-only and stores no content or snapshots in its public plan', async () => {
  await fixture(async (root, store) => {
    const plan = await previewImport(store, profile);
    assert.deepEqual(await readdir(root), []);
    assert.equal(plan.resources, 3);
    assert.equal(plan.entrypoints, 2);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(JSON.stringify(plan).includes('Synthetic'), false);
    assert.equal(JSON.stringify(plan).includes('quietStartup'), false);
  });
});

test('staging copies explicit resources without modifying global configuration or executing them', async () => {
  await fixture(async (root, store) => {
    await native(root);
    const original = await readFile(join(root, 'settings.json'));
    const plan = await previewImport(store, profile);
    await assert.rejects(applyImport(store, plan, false), { code: 'consent-required' });
    await applyImport(store, plan, true);
    assert.deepEqual(await readFile(join(root, 'settings.json')), original);
    assert.equal(await readFile(join(root, base(plan.importId), 'resources/extension/main.ts'), 'utf8'), profile.resources[0]?.content);
    const manifest = JSON.parse(await readFile(join(root, base(plan.importId), 'manifest.json'), 'utf8'));
    assert.equal(manifest.state, 'staged');
    assert.equal(manifest.stageTransactionId, plan.importId);
    assert.equal((await store.read('mcp.json')).bytes, null);
  });
});

test('plans are copied, store-bound, unforgeable and consumed after application', async () => {
  await fixture(async (root, store) => {
    const input = structuredClone(profile);
    const plan = await previewImport(store, input);
    input.resources[0]!.content = 'changed after preview';
    await assert.rejects(applyImport(store, { ...plan } as StagingPlan, true), { code: 'invalid-state' });
    await assert.rejects(applyImport(await FileStore.open(root), plan, true), { code: 'invalid-state' });
    await applyImport(store, plan, true);
    assert.equal(await readFile(join(root, base(plan.importId), 'resources/extension/main.ts'), 'utf8'), profile.resources[0]?.content);
    await assert.rejects(applyImport(store, plan, true), { code: 'invalid-state' });
  });
});

test('a stale staging destination is preserved and no other profile file is written', async () => {
  await fixture(async (root, store) => {
    await applyImport(store, await previewImport(store, empty), true);
    const plan = await previewImport(store, profile);
    const path = join(root, base(plan.importId), 'resources/extension/main.ts');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'later work');
    await assert.rejects(applyImport(store, plan, true), { code: 'changed' });
    assert.equal(await readFile(path, 'utf8'), 'later work');
    assert.equal((await store.read(`${base(plan.importId)}/profile.json`)).bytes, null);
  });
});

test('a staging manifest write failure rolls back resources and profile together', async t => {
  await fixture(async (_root, store) => {
    const plan = await previewImport(store, profile);
    const original = store.write.bind(store);
    t.mock.method(store, 'write', async (path: string, bytes: Uint8Array, before: FileSnapshot) => {
      if (path === `${base(plan.importId)}/manifest.json`) throw new StorageError('unavailable');
      return original(path, bytes, before);
    });
    await assert.rejects(applyImport(store, plan, true), { code: 'unavailable' });
    assert.equal((await store.read(`${base(plan.importId)}/profile.json`)).bytes, null);
    assert.equal((await store.read(`${base(plan.importId)}/resources/extension/main.ts`)).bytes, null);
    assert.equal((await store.read('setup-share/pending.json')).bytes, null);
  });
});

test('activation separately confirms configuration and registers only explicit entrypoints', async () => {
  await fixture(async (root, store) => {
    await native(root);
    const stage = await previewImport(store, profile);
    await applyImport(store, stage, true);
    const original = await readFile(join(root, 'settings.json'));
    const plan = await previewActivation(store, stage.importId);
    assert.deepEqual(await readFile(join(root, 'settings.json')), original);
    assert.equal(Object.isFrozen(plan.items), true);
    assert.ok(plan.items.every(Object.isFrozen));
    assert.equal(plan.items.find(item => item.id === 'preferences.quietStartup')?.action, 'preserve');
    await assert.rejects(activateImport(store, plan, false), { code: 'consent-required' });
    await activateImport(store, plan, true);
    const settings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
    assert.equal(settings.quietStartup, false);
    assert.deepEqual(settings.unrelated, { keep: true });
    assert.deepEqual(settings.extensions, ['./existing.ts', `./${base(stage.importId)}/resources/extension/main.ts`]);
    assert.deepEqual(settings.prompts, [`./${base(stage.importId)}/resources/prompt/example.md`]);
    assert.equal(JSON.stringify(settings).includes('support.ts'), false);
    assert.equal((await store.read('mcp.json')).bytes, null);
    await assert.rejects(previewActivation(store, stage.importId), { code: 'invalid-state' });
    await assert.rejects(activateImport(store, plan, true), { code: 'invalid-state' });
  });
});

test('explicit overwrite resolves selected conflicts without replacing unrelated settings', async () => {
  await fixture(async (root, store) => {
    await native(root);
    const stage = await previewImport(store, profile);
    await applyImport(store, stage, true);
    const plan = await previewActivation(store, stage.importId, { configuration: { 'preferences.quietStartup': 'overwrite', 'keybindings.app.interrupt': 'overwrite' } });
    await activateImport(store, plan, true);
    assert.equal(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).quietStartup, true);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'keybindings.json'), 'utf8')), { 'app.interrupt': [] });
  });
});

test('invalid resource-list shape requires explicit overwrite rather than silent replacement', async () => {
  await fixture(async (root, store) => {
    await writeFile(join(root, 'settings.json'), '{"extensions":false}');
    const stage = await previewImport(store, profile);
    await applyImport(store, stage, true);
    const preserve = await previewActivation(store, stage.importId);
    assert.deepEqual(preserve.items.find(item => item.id === 'resources.extension'), { id: 'resources.extension', status: 'conflict', action: 'preserve' });
    const overwrite = await previewActivation(store, stage.importId, { resources: { 'resources.extension': 'overwrite' } });
    await activateImport(store, overwrite, true);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).extensions, [`./${base(stage.importId)}/resources/extension/main.ts`]);
  });
});

test('changes to any global configuration after preview reject activation before writes', async () => {
  for (const path of ['settings.json', 'keybindings.json', 'mcp.json']) {
    await fixture(async (root, store) => {
      const stage = await previewImport(store, profile);
      await applyImport(store, stage, true);
      const manifest = await store.read(`${base(stage.importId)}/manifest.json`);
      const plan = await previewActivation(store, stage.importId);
      await writeFile(join(root, path), '{"subsequent":"work"}');
      await assert.rejects(activateImport(store, plan, true), { code: 'changed' });
      assert.equal(await store.matches(`${base(stage.importId)}/manifest.json`, manifest), true);
      assert.equal(await readFile(join(root, path), 'utf8'), '{"subsequent":"work"}');
    });
  }
});

test('changed staged content cannot be activated before or after preview', async () => {
  for (const afterPreview of [false, true]) {
    await fixture(async (root, store) => {
      const stage = await previewImport(store, profile);
      await applyImport(store, stage, true);
      const plan = afterPreview ? await previewActivation(store, stage.importId) : undefined;
      await writeFile(join(root, base(stage.importId), 'resources/extension/main.ts'), 'later edit');
      await assert.rejects(plan ? activateImport(store, plan, true) : previewActivation(store, stage.importId), { code: 'changed' });
      assert.equal((await store.read('settings.json')).bytes, null);
    });
  }
});

test('activation manifest failure rolls back all global changes and retains staged state', async t => {
  await fixture(async (root, store) => {
    await native(root);
    const settings = await readFile(join(root, 'settings.json'));
    const stage = await previewImport(store, profile);
    await applyImport(store, stage, true);
    const plan = await previewActivation(store, stage.importId);
    const original = store.write.bind(store);
    t.mock.method(store, 'write', async (path: string, bytes: Uint8Array, before: FileSnapshot) => {
      if (path === `${base(stage.importId)}/manifest.json`) throw new StorageError('unavailable');
      return original(path, bytes, before);
    });
    await assert.rejects(activateImport(store, plan, true), { code: 'unavailable' });
    assert.deepEqual(await readFile(join(root, 'settings.json')), settings);
    assert.equal(JSON.parse(await readFile(join(root, base(stage.importId), 'manifest.json'), 'utf8')).state, 'staged');
  });
});

test('package descriptors remain deferred and never become global install references', async () => {
  await fixture(async (_root, store) => {
    const stage = await previewImport(store, { ...empty, packages: [{ source: 'npm:synthetic-package@1.2.3' }] });
    await applyImport(store, stage, true);
    const plan = await previewActivation(store, stage.importId);
    assert.equal(plan.deferredPackages, 1);
    await activateImport(store, plan, true);
    assert.equal((await store.read('settings.json')).bytes, null);
  });
});

test('agent directories preserve relative supports without discovering unselected Markdown', async () => {
  await fixture(async (root, store) => {
    const input = { ...empty, resources: [
      { kind: 'agent', path: 'team/main.md', encoding: 'utf8', content: '---\nname: synthetic\ndescription: Synthetic agent\n---\nSynthetic instructions' },
      { kind: 'agent', path: 'team/support.txt', encoding: 'utf8', content: 'Synthetic support' },
      { kind: 'agent', path: 'unselected/notes.md', encoding: 'utf8', content: 'Outside selected discovery directory' },
    ], entrypoints: { agent: ['team/main.md'] } };
    const stage = await previewImport(store, input);
    await applyImport(store, stage, true);
    const pkg = JSON.parse(await readFile(join(root, base(stage.importId), 'agents-package/package.json'), 'utf8'));
    assert.deepEqual(pkg['pi-subagents'].agents, ['./agents/team']);
    await activateImport(store, await previewActivation(store, stage.importId), true);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).packages, [{ source: `./${base(stage.importId)}/agents-package`, extensions: [], skills: [], prompts: [], themes: [] }]);
  });
});

test('potentially discoverable unselected agent Markdown blocks activation but not inert staging', async () => {
  await fixture(async (_root, store) => {
    const stage = await previewImport(store, { ...empty, resources: [
      { kind: 'agent', path: 'main.md', encoding: 'utf8', content: 'Synthetic main' },
      { kind: 'agent', path: 'nested/support.md', encoding: 'utf8', content: 'Synthetic support' },
    ], entrypoints: { agent: ['main.md'] } });
    await applyImport(store, stage, true);
    await assert.rejects(previewActivation(store, stage.importId), { code: 'invalid-state' });
    assert.equal((await store.read('settings.json')).bytes, null);
    await restoreImport(store, stage.importId, true);
  });
});

test('agent Markdown added on disk after staging or preview is not implicitly activated', async () => {
  for (const afterPreview of [false, true]) {
    await fixture(async (root, store) => {
      const stage = await previewImport(store, { ...empty, resources: [
        { kind: 'agent', path: 'main.md', encoding: 'utf8', content: 'Synthetic main' },
      ], entrypoints: { agent: ['main.md'] } });
      await applyImport(store, stage, true);
      const plan = afterPreview ? await previewActivation(store, stage.importId) : undefined;
      await writeFile(join(root, base(stage.importId), 'agents-package/agents/extra.md'), '---\nname: extra\ndescription: Unselected agent\n---\nSynthetic');
      await assert.rejects(plan ? activateImport(store, plan, true) : previewActivation(store, stage.importId), { code: 'changed' });
      assert.equal((await store.read('settings.json')).bytes, null);
    });
  }
});

test('restoring an active import removes staged files and restores original configuration bytes', async () => {
  await fixture(async (root, store) => {
    await native(root);
    const original = await readFile(join(root, 'settings.json'));
    const stage = await previewImport(store, profile);
    await applyImport(store, stage, true);
    await activateImport(store, await previewActivation(store, stage.importId), true);
    await assert.rejects(restoreImport(store, stage.importId, false), { code: 'consent-required' });
    await restoreImport(store, stage.importId, true);
    assert.deepEqual(await readFile(join(root, 'settings.json')), original);
    assert.equal((await store.read(`${base(stage.importId)}/manifest.json`)).bytes, null);
    assert.equal((await store.read(`${base(stage.importId)}/resources/extension/main.ts`)).bytes, null);
  });
});

test('a failed chain cursor update leaves the complete import recoverable', async t => {
  await fixture(async (_root, store) => {
    const stage = await previewImport(store, profile);
    await applyImport(store, stage, true);
    await activateImport(store, await previewActivation(store, stage.importId), true);
    const original = store.write.bind(store);
    let writes = 0;
    t.mock.method(store, 'write', async (path: string, bytes: Uint8Array, before: FileSnapshot) => {
      if (path === 'setup-share/pending.json' && ++writes === 2) throw new StorageError('unavailable');
      return original(path, bytes, before);
    });
    await assert.rejects(restoreImport(store, stage.importId, true), { code: 'recovery-required' });
    t.mock.restoreAll();
    await assert.rejects(previewImport(store, empty), { code: 'recovery-required' });
    await recoverChanges(store, true);
    assert.equal((await store.read('settings.json')).bytes, null);
    assert.equal((await store.read(`${base(stage.importId)}/manifest.json`)).bytes, null);
    assert.equal((await store.read('setup-share/pending.json')).bytes, null);
  });
});

test('later edits or altered manifest history cannot be overwritten by restore', async () => {
  for (const alteredHistory of [false, true]) {
    await fixture(async (root, store) => {
      const stage = await previewImport(store, profile);
      await applyImport(store, stage, true);
      await activateImport(store, await previewActivation(store, stage.importId), true);
      if (alteredHistory) {
        const path = join(root, base(stage.importId), 'manifest.json');
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        manifest.stageTransactionId = '11111111-1111-4111-8111-111111111111';
        await writeFile(path, JSON.stringify(manifest));
      } else await writeFile(join(root, 'settings.json'), '{"later":true}');
      await assert.rejects(restoreImport(store, stage.importId, true), { code: alteredHistory ? 'invalid-state' : 'changed' });
      assert.notEqual((await store.read(`${base(stage.importId)}/resources/extension/main.ts`)).bytes, null);
    });
  }
});

test('agent directory enumeration is bounded even when added files are not Markdown', async () => {
  await fixture(async (root, store) => {
    const stage = await previewImport(store, { ...empty, resources: [
      { kind: 'agent', path: 'main.md', encoding: 'utf8', content: 'Synthetic main' },
    ], entrypoints: { agent: ['main.md'] } });
    await applyImport(store, stage, true);
    for (let index = 0; index < 1024; index++) await writeFile(join(root, base(stage.importId), `agents-package/agents/extra-${index}.txt`), 'synthetic');
    await assert.rejects(previewActivation(store, stage.importId), { code: 'limit-exceeded' });
    assert.equal((await store.read('settings.json')).bytes, null);
  });
});

test('replaying an exact staged manifest cannot hide an applied activation', async () => {
  await fixture(async (root, store) => {
    const stage = await previewImport(store, profile);
    await applyImport(store, stage, true);
    const path = `${base(stage.importId)}/manifest.json`;
    const staged = await readFile(join(root, path));
    await activateImport(store, await previewActivation(store, stage.importId), true);
    const settings = await readFile(join(root, 'settings.json'));
    await writeFile(join(root, path), staged);
    await assert.rejects(restoreImport(store, stage.importId, true), { code: 'changed' });
    await assert.rejects(previewActivation(store, stage.importId), { code: 'changed' });
    assert.deepEqual(await readFile(join(root, 'settings.json')), settings);
    assert.notEqual((await store.read(`${base(stage.importId)}/resources/extension/main.ts`)).bytes, null);
  });
});

test('cancelled staging and activation leave destinations intact', async () => {
  await fixture(async (_root, store) => {
    const signal = AbortSignal.abort('reason must not escape');
    const stage = await previewImport(store, profile);
    await assert.rejects(applyImport(store, stage, true, signal), { code: 'aborted' });
    assert.equal((await store.read(`${base(stage.importId)}/manifest.json`)).bytes, null);
    await applyImport(store, stage, true);
    const activation = await previewActivation(store, stage.importId);
    await assert.rejects(activateImport(store, activation, true, signal), { code: 'aborted' });
    assert.equal((await store.read('settings.json')).bytes, null);
  });
});
