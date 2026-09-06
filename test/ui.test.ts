import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { inspectImport, listImports, type PackageInstallerFactory } from '../src/import.ts';
import { en } from '../src/locales/en.ts';
import { readProfileFile, writeProfileFile } from '../src/profile-file.ts';
import { FileStore } from '../src/storage.ts';
import { runSetupShare } from '../src/ui.ts';

type Choice = boolean | { count: number; include: number[] };
function context(menu: (string | ((options: string[]) => string))[], inputs: string[], choices: Choice[], confirms: boolean[] = []) {
  const notifications: string[] = [];
  const screens: string[] = [];
  const menus: string[][] = [];
  const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;
  const ctx = { mode: 'tui', hasUI: true, ui: {
    select: async (_title: string, options: string[]) => { menus.push(options); const next = menu.shift(); return typeof next === 'function' ? next(options) : next; },
    input: async () => inputs.shift(),
    confirm: async () => confirms.shift() ?? false,
    notify: (message: string) => notifications.push(message),
    custom: (factory: (tui: TUI, theme: Theme, keys: unknown, done: (result: unknown) => void) => Component) => new Promise(resolve => {
      const component = factory(tui, theme, {}, resolve);
      const rendered = component.render(80).join('\n');
      screens.push(rendered);
      if (rendered.startsWith(en.review)) { component.handleInput?.('\r'); return; }
      if (rendered.includes(en.working) || rendered.includes(en.installing) || rendered.includes(en.reading)) return;
      const choice = choices.shift();
      assert.notEqual(choice, undefined, 'unexpected dialog');
      if (typeof choice === 'boolean') {
        if (choice) component.handleInput?.('\x1b[B');
        component.handleInput?.('\r');
      } else if (choice) {
        for (let index = 0; index < choice.count; index++) {
          if (choice.include.includes(index)) component.handleInput?.(' ');
          component.handleInput?.('\x1b[B');
        }
        component.handleInput?.('\r');
      }
    }),
  } } as unknown as ExtensionCommandContext;
  return { ctx, notifications, screens, menus, choices };
}
const noInstall: PackageInstallerFactory = () => { throw new Error('unexpected installation'); };
const profile = { format: 'pi-setup-share', version: 1, resources: [], preferences: { quietStartup: true } };
async function fixture(run: (root: string, agent: string, store: FileStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-setup-share-ui-'));
  const agent = join(root, 'agent');
  await mkdir(agent);
  try { await run(root, agent, await FileStore.open(agent)); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

test('inspection is read-only, does not install or expose resource contents', async () => {
  await fixture(async (root, agent, store) => {
    const source = join(root, 'profile.zip');
    await writeProfileFile(source, { ...profile, resources: [{ kind: 'extension', path: 'main.ts', encoding: 'utf8', content: 'SYNTHETIC_CODE_MUST_NOT_EXECUTE' }] }, true);
    const ui = context([en.inspect], [source], []);
    await runSetupShare(ui.ctx, agent, noInstall);
    assert.deepEqual(await listImports(store), []);
    assert.equal(ui.screens.join('').includes('SYNTHETIC_CODE_MUST_NOT_EXECUTE'), false);
  });
});

test('stage refusal is side-effect free; Later, resume, activation and restore retain their separate gates', async () => {
  await fixture(async (root, agent, store) => {
    const source = join(root, 'profile.json');
    await writeFile(source, JSON.stringify(profile));
    const refused = context([en.import], [source], [{ count: 1, include: [0] }, false]);
    await runSetupShare(refused.ctx, agent, noInstall);
    assert.deepEqual(await listImports(store), []);
    const staged = context([en.import], [source], [{ count: 1, include: [0] }, true, false]);
    await runSetupShare(staged.ctx, agent, noInstall);
    const id = (await listImports(store))[0]!;
    assert.equal((await inspectImport(store, id)).state, 'staged');
    assert.equal((await store.read('settings.json')).bytes, null);
    const resumed = context([en.resume, options => options[0]!], [], [true]);
    await runSetupShare(resumed.ctx, agent, noInstall);
    assert.match(resumed.menus[1]?.[0] ?? '', /Staged.*Activate/);
    assert.equal((await inspectImport(store, id)).state, 'active');
    assert.equal(JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')).quietStartup, true);
    const restored = context([en.restore, options => options[0]!], [], [true]);
    await runSetupShare(restored.ctx, agent, noInstall);
    assert.deepEqual(await listImports(store), []);
    assert.equal((await store.read('settings.json')).bytes, null);
  });
});

test('package Later stays inactive, resumed installation is isolated, and activation is still deferred', async () => {
  await fixture(async (root, agent, store) => {
    const source = join(root, 'profile.json');
    await writeFile(source, JSON.stringify({ format: 'pi-setup-share', version: 1, resources: [], packages: [{ source: 'npm:example@1.2.3' }] }));
    let calls = 0;
    const installer: PackageInstallerFactory = packageStore => ({
      install: async () => { calls++; await mkdir(join(packageStore, 'installed')); },
      getInstalledPath: () => join(packageStore, 'installed'),
    });
    await runSetupShare(context([en.import], [source], [{ count: 1, include: [0] }, true, false]).ctx, agent, installer);
    const id = (await listImports(store))[0]!;
    assert.equal(calls, 0);
    await runSetupShare(context([en.resume, options => options[0]!], [], [true, false]).ctx, agent, installer);
    assert.equal(calls, 1);
    assert.equal((await inspectImport(store, id)).state, 'installed');
    assert.equal((await store.read('settings.json')).bytes, null);
    await runSetupShare(context([en.resume, options => options[0]!], [], [true]).ctx, agent, installer);
    const settings = JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8'));
    assert.match(settings.packages[0].source, /^\.\/setup-share\/imports\//);
    assert.equal(calls, 1);
  });
});

test('export selects individual global fields and does not leak excluded values', async () => {
  await fixture(async (root, agent) => {
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, syntheticPrivate: 'EXCLUDED_SENTINEL' }));
    const output = join(root, 'export.zip');
    const ui = context([en.export], [output], [{ count: 5, include: [0] }, { count: 1, include: [0] }, true], [false]);
    await runSetupShare(ui.ctx, agent, noInstall);
    const exported = await readProfileFile(output);
    assert.deepEqual(exported.preferences, { quietStartup: true });
    assert.equal(JSON.stringify(exported).includes('EXCLUDED_SENTINEL'), false);
    assert.equal(ui.screens.join('').includes('EXCLUDED_SENTINEL'), false);
    assert.match(ui.screens.join(''), /Unsupported field omitted/);
    assert.equal(ui.notifications.join('').includes(root), false);
  });
});

test('export explains omitted MCP servers and selects every portable server at once', async () => {
  await fixture(async (root, agent) => {
    await writeFile(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: {
      portable: { command: 'npx', args: ['synthetic-package@1.2.3'] },
      localOnly: { command: 'node', args: ['C:\\synthetic\\private\\server.js'] },
    } }));
    const output = join(root, 'mcp-export.zip');
    const ui = context([en.export], [output], [
      { count: 5, include: [2] }, { count: 2, include: [0] }, true,
    ], [false]);
    await runSetupShare(ui.ctx, agent, noInstall);
    const exported = await readProfileFile(output);
    assert.deepEqual(Object.keys(exported.integrations?.mcpServers ?? {}), ['portable']);
    assert.match(ui.screens.join('\n'), /localOnly: Not portable/);
    assert.equal(ui.screens.join('\n').includes('synthetic\\private'), false);
  });
});

test('non-TUI invocation does not access UI, configuration or packages', async () => {
  await runSetupShare({ mode: 'rpc', hasUI: true } as ExtensionCommandContext, '/not-accessed', noInstall);
});
