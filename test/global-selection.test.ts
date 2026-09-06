import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readGlobalCategory, selectGlobalCategory } from '../src/global-selection.ts';
import { FileStore } from '../src/storage.ts';

async function fixture(run: (root: string, store: FileStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-setup-share-global-'));
  try { await run(root, await FileStore.open(root)); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

test('global candidates contain only projected fields and explicit selection preserves false and zero', async () => {
  await fixture(async (root, store) => {
    const source = JSON.stringify({ quietStartup: false, editorPaddingX: 0, syntheticUnknown: 'excluded-value', subagents: { disableBuiltins: false, operational: 'excluded-value' } });
    await writeFile(join(root, 'settings.json'), source);
    const preview = await readGlobalCategory(store, 'preferences');
    assert.equal(JSON.stringify(preview).includes('excluded-value'), false);
    assert.deepEqual(selectGlobalCategory(preview, []).preferences, {});
    const ids = preview.items.filter(item => item.label === 'editorPaddingX').map(item => item.id);
    assert.deepEqual(selectGlobalCategory(preview, ids).preferences, { editorPaddingX: 0 });
    const agents = await readGlobalCategory(store, 'subagents');
    assert.deepEqual(selectGlobalCategory(agents, agents.items.map(item => item.id)).integrations?.subagents, { disableBuiltins: false });
    assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), source);
  });
});

test('MCP selection keeps environment names but never reprojects or returns their values', async () => {
  await fixture(async (root, store) => {
    await writeFile(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { example: { command: 'example-server', env: { EXAMPLE_KEY: 'excluded-value' } } } }));
    const preview = await readGlobalCategory(store, 'mcpServers');
    assert.equal(JSON.stringify(preview).includes('excluded-value'), false);
    const server = selectGlobalCategory(preview, ['0']).integrations?.mcpServers?.example;
    assert.deepEqual(server?.envNames, ['EXAMPLE_KEY']);
    assert.equal(server?.disabled, true);
    assert.equal(server?.approveTools, true);
  });
});

test('MCP preview exposes portable candidates and safe names for omitted servers', async () => {
  await fixture(async (root, store) => {
    await writeFile(join(root, 'mcp.json'), JSON.stringify({ mcpServers: {
      portable: { command: 'npx', args: ['synthetic-package@1.2.3'] },
      localOnly: { command: 'node', args: ['C:\\synthetic\\private\\server.js'] },
    } }));
    const preview = await readGlobalCategory(store, 'mcpServers');
    assert.deepEqual(preview.items.map(item => item.label), ['portable']);
    assert.deepEqual(preview.diagnostics.find(item => item.label)?.label, 'localOnly');
    assert.equal(JSON.stringify(preview).includes('synthetic\\private'), false);
  });
});

test('absence is distinct from empty global configuration and invalid roots fail', async () => {
  await fixture(async (root, store) => {
    const absent = await readGlobalCategory(store, 'keybindings');
    assert.equal(Object.hasOwn(selectGlobalCategory(absent, []), 'keybindings'), false);
    await writeFile(join(root, 'keybindings.json'), '{}');
    assert.deepEqual(selectGlobalCategory(await readGlobalCategory(store, 'keybindings'), []).keybindings, {});
    await writeFile(join(root, 'settings.json'), '{"packages":null}');
    await assert.rejects(readGlobalCategory(store, 'packages'));
  });
});

test('selection rejects unknown or duplicate IDs and keeps package filters', async () => {
  await fixture(async (root, store) => {
    await writeFile(join(root, 'settings.json'), JSON.stringify({ packages: [{ source: 'npm:example@1.2.3', extensions: [] }] }));
    const preview = await readGlobalCategory(store, 'packages');
    assert.throws(() => selectGlobalCategory(preview, ['missing']));
    assert.throws(() => selectGlobalCategory(preview, ['0', '0']));
    assert.deepEqual(selectGlobalCategory(preview, ['0']).packages, [{ source: 'npm:example@1.2.3', extensions: [] }]);
  });
});
