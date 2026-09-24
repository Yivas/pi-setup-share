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
function context(menu: (string | ((options: string[]) => string))[], inputs: string[], choices: Choice[], confirms: boolean[] = [], viewport: { width: number; rows: number } = { width: 80, rows: 24 }) {
  const notifications: string[] = [];
  const screens: string[] = [];
  const menus: string[][] = [];
  const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  const tui = { terminal: { rows: viewport.rows }, requestRender() {} } as unknown as TUI;
  const ctx = { mode: 'tui', hasUI: true, ui: {
    select: async (_title: string, options: string[]) => { menus.push(options); const next = menu.shift(); return typeof next === 'function' ? next(options) : next; },
    input: async () => inputs.shift(),
    confirm: async () => confirms.shift() ?? false,
    notify: (message: string) => notifications.push(message),
    custom: (factory: (tui: TUI, theme: Theme, keys: unknown, done: (result: unknown) => void) => Component) => new Promise(resolve => {
      const component = factory(tui, theme, {}, resolve);
      const rendered = component.render(viewport.width).join('\n');
      screens.push(rendered);
      if (rendered.startsWith(en.review)) {
        let page = rendered;
        for (let guard = 0; guard < 100 && page.includes(`  ${en.next}`); guard++) {
          component.handleInput?.('\x1b[B');
          component.handleInput?.('\r');
          page = component.render(viewport.width).join('\n');
          screens.push(page);
        }
        component.handleInput?.('\r');
        return;
      }
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
const isolatedInstaller: PackageInstallerFactory = packageStore => ({
  install: async () => { await mkdir(join(packageStore, 'installed')); },
  getInstalledPath: () => join(packageStore, 'installed'),
});
async function conflictFixture(root: string, agent: string): Promise<string> {
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ quietStartup: false, prompts: false, packages: [{ source: 'npm:example@9.9.9' }] }));
  await writeFile(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { example: { command: 'node', args: ['existing.js'] } } }));
  const source = join(root, 'conflicts.json');
  await writeFile(source, JSON.stringify({ format: 'pi-setup-share', version: 1,
    resources: [{ kind: 'prompt', path: 'hello.md', encoding: 'utf8', content: 'Synthetic' }],
    entrypoints: { prompt: ['hello.md'] },
    preferences: { quietStartup: true },
    packages: [{ source: 'npm:example@1.2.3' }],
    integrations: { mcpServers: { example: { disabled: true, approveTools: true, command: 'node', args: ['other.js'] } } },
  }));
  return source;
}
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

test('receiver sees the transported omission report before staging v2', async () => {
  await fixture(async (root, agent, store) => {
    const source = join(root, 'v2.json');
    await writeFile(source, JSON.stringify({ format: 'pi-setup-share', version: 2, resources: [],
      transfer: { scanned: ['mcpServers'], partial: [], notExamined: ['project'],
        omissions: [{ category: 'mcpServers', reason: 'unsupported', count: 1 }], actions: ['review-omissions'] },
    }));
    const ui = context([en.import], [source], [false]);
    await runSetupShare(ui.ctx, agent, noInstall);
    assert.match(ui.screens.join(''), /MCP servers: 1 unsupported/);
    assert.match(ui.screens.join(''), /Review omissions/);
    assert.deepEqual(await listImports(store), []);
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

test('sender report counts omitted subagent overrides and unpinned packages without their values', async () => {
  await fixture(async (root, agent) => {
    await writeFile(join(agent, 'settings.json'), JSON.stringify({
      subagents: { disableBuiltins: false, overrides: { privateAgent: 'SYNTHETIC_SECRET_SENTINEL' } },
      packages: ['npm:example@1.2.3', 'npm:unversioned@latest'],
    }));
    const output = join(root, 'omissions.zip');
    const ui = context([en.export], [output], [
      { count: 5, include: [3, 4] }, { count: 1, include: [0] }, { count: 1, include: [0] }, true,
    ], [false]);
    await runSetupShare(ui.ctx, agent, noInstall, root);
    const exported = await readProfileFile(output);
    assert.ok(exported.transfer?.omissions.some(item => item.category === 'subagents' && item.reason === 'unsupported'));
    assert.ok(exported.transfer?.omissions.some(item => item.category === 'packages' && item.reason === 'unsupported'));
    assert.equal(JSON.stringify(exported).includes('SYNTHETIC_SECRET_SENTINEL'), false);
    assert.equal(ui.screens.join('').includes('SYNTHETIC_SECRET_SENTINEL'), false);
  });
});

test('export selects discovered global files without reading unselected secrets', async () => {
  await fixture(async (root, agent) => {
    await mkdir(join(agent, 'extensions'));
    await mkdir(join(agent, 'skills', 'craft'), { recursive: true });
    await writeFile(join(agent, 'extensions', 'sample.ts'), 'synthetic-extension');
    await writeFile(join(agent, 'skills', 'craft', 'SKILL.md'), 'synthetic-skill');
    await writeFile(join(agent, 'skills', 'craft', '.env'), 'SYNTHETIC_SECRET_NOT_EXPORTED');
    const output = join(root, 'resources.zip');
    const ui = context([en.export], [output], [
      { count: 5, include: [] }, { count: 2, include: [0, 1] }, true,
    ], [true, true, true, true, false]);
    await runSetupShare(ui.ctx, agent, noInstall, root);
    const exported = await readProfileFile(output);
    assert.equal(exported.version, 2);
    assert.deepEqual(exported.resources.map(resource => resource.path), ['sample.ts', 'craft/SKILL.md']);
    assert.ok(exported.transfer?.scanned.includes('skill'));
    assert.equal(exported.transfer?.omissions.some(item => item.reason === 'excluded'), true);
    assert.deepEqual(exported.entrypoints, { extension: ['sample.ts'], skill: ['craft/SKILL.md'] });
    assert.equal(JSON.stringify(exported).includes('SYNTHETIC_SECRET_NOT_EXPORTED'), false);
    assert.equal(exported.transfer?.notExamined.includes('project'), true);
    assert.equal(ui.screens.join('').includes('SYNTHETIC_SECRET_NOT_EXPORTED'), false);
  });
});

test('moves a synthetic sender setup to another agent directory with separate install, activation and restore', async () => {
  await fixture(async (root, sender) => {
    const receiver = join(root, 'receiver');
    await mkdir(receiver);
    await writeFile(join(sender, 'settings.json'), JSON.stringify({ quietStartup: true,
      packages: [{ source: 'npm:example@1.2.3' }, { source: `git:github.com/example/tools@${'a'.repeat(40)}` }],
      unknownPrivate: 'SYNTHETIC_SECRET_SENTINEL' }));
    await writeFile(join(sender, 'keybindings.json'), JSON.stringify({ 'app.interrupt': [] }));
    await writeFile(join(sender, 'mcp.json'), JSON.stringify({ mcpServers: {
      example: { command: 'example-server', env: { EXAMPLE_KEY: 'SYNTHETIC_SECRET_SENTINEL' } },
      localOnly: { command: 'node', args: ['C:\\synthetic\\private\\server.js'] },
    } }));
    await mkdir(join(sender, 'extensions'));
    await mkdir(join(sender, 'skills', 'craft'), { recursive: true });
    await mkdir(join(sender, 'prompts'));
    await mkdir(join(sender, 'themes'));
    await mkdir(join(sender, 'agents'));
    await writeFile(join(sender, 'extensions', 'sample.ts'), 'export default function setup() {}');
    await writeFile(join(sender, 'extensions', '.env'), 'SYNTHETIC_SECRET_SENTINEL');
    await writeFile(join(sender, 'skills', 'craft', 'SKILL.md'), '---\nname: craft\ndescription: Synthetic skill\n---\n# Craft');
    await writeFile(join(sender, 'skills', 'craft', 'support.ts'), 'export const craft = true;');
    await writeFile(join(sender, 'skills', 'craft', '.npmrc'), 'SYNTHETIC_SECRET_SENTINEL');
    await writeFile(join(sender, 'prompts', 'hello.md'), '# Synthetic prompt');
    await writeFile(join(sender, 'themes', 'blue.json'), '{"name":"blue","colors":{}}');
    await writeFile(join(sender, 'agents', 'helper.md'), '# Synthetic agent');
    await writeFile(join(sender, 'agents', 'support.ts'), 'export const helper = true;');
    await mkdir(join(receiver, 'extensions'));
    await writeFile(join(receiver, 'extensions', 'sample.ts'), 'ORIGINAL_RECEIVER_EXTENSION');
    const originalSettings = '{"quietStartup":false,"unrelated":"keep"}\n';
    await writeFile(join(receiver, 'settings.json'), originalSettings);
    const archive = join(root, 'portable.zip');
    const exported = context([en.export], [archive], [
      { count: 5, include: [0, 1, 2, 4] }, { count: 1, include: [0] }, { count: 1, include: [0] },
      { count: 2, include: [0] }, { count: 2, include: [0, 1] }, { count: 7, include: [0, 1, 2, 3, 4, 5, 6] }, true,
    ], [true, true, true, true, true, true, true, false]);
    await runSetupShare(exported.ctx, sender, noInstall, root);
    const transferred = await readProfileFile(archive);
    assert.equal(transferred.version, 2);
    assert.equal(transferred.integrations?.mcpServers?.example?.envNames?.[0], 'EXAMPLE_KEY');
    assert.equal(JSON.stringify(transferred).includes('SYNTHETIC_SECRET_SENTINEL'), false);
    assert.deepEqual(transferred.keybindings, { 'app.interrupt': [] });
    assert.equal(transferred.packages?.length, 2);
    assert.equal(transferred.transfer?.omissions.some(item => item.category === 'mcpServers' && item.reason === 'unsupported'), true);
    assert.equal(exported.screens.join('').includes('SYNTHETIC_SECRET_SENTINEL'), false);
    assert.equal(exported.screens.join('').includes('private\\server.js'), false);
    assert.equal(exported.screens.join('').includes('.npmrc'), false);
    assert.deepEqual(transferred.resources.map(resource => `${resource.kind}/${resource.path}`), [
      'extension/sample.ts', 'skill/craft/SKILL.md', 'skill/craft/support.ts',
      'prompt/hello.md', 'theme/blue.json', 'agent/helper.md', 'agent/support.ts',
    ]);
    assert.deepEqual(transferred.entrypoints, { extension: ['sample.ts'], skill: ['craft/SKILL.md'],
      prompt: ['hello.md'], theme: ['blue.json'], agent: ['helper.md'] });
    const receiverStore = await FileStore.open(receiver);
    const inspected = context([en.inspect], [archive], []);
    await runSetupShare(inspected.ctx, receiver, noInstall, root);
    assert.match(inspected.screens.join(''), /Sender-supplied inventory report/);
    assert.deepEqual(await listImports(receiverStore), []);
    assert.equal(await readFile(join(receiver, 'settings.json'), 'utf8'), originalSettings);
    let installs = 0;
    const installed = (packageStore: string, source: string) => join(packageStore, source.startsWith('npm:') ? 'npm' : 'git');
    const installer: PackageInstallerFactory = packageStore => ({
      install: async source => { installs++; await mkdir(installed(packageStore, source)); },
      getInstalledPath: source => installed(packageStore, source),
    });
    const imported = context([en.import], [archive], [
      { count: 1, include: [0] }, { count: 1, include: [0] }, { count: 2, include: [0] },
      { count: 2, include: [0, 1] }, { count: 7, include: [0, 1, 2, 3, 4, 5, 6] }, true, false,
    ]);
    await runSetupShare(imported.ctx, receiver, installer, root);
    assert.equal(installs, 0);
    const id = (await listImports(receiverStore))[0]!;
    assert.equal((await inspectImport(receiverStore, id)).state, 'staged');
    assert.equal(await readFile(join(receiver, 'settings.json'), 'utf8'), originalSettings);
    const reportIndex = imported.screens.findIndex(screen => screen.includes('Sender-supplied inventory report'));
    const stageIndex = imported.screens.findIndex(screen => screen.includes(en.stageTitle));
    assert.ok(reportIndex >= 0 && stageIndex > reportIndex);
    const resumed = context([en.resume, options => options[0]!, en.overwrite], [], [true, true]);
    await runSetupShare(resumed.ctx, receiver, installer, root);
    assert.ok(resumed.menus.some(options => options.includes(en.preserve) && options.includes(en.overwrite)));
    assert.equal(installs, 2);
    assert.equal((await inspectImport(receiverStore, id)).state, 'active');
    const settings = JSON.parse(await readFile(join(receiver, 'settings.json'), 'utf8'));
    assert.equal(settings.quietStartup, true);
    const mcp = JSON.parse(await readFile(join(receiver, 'mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers.example.disabled, true);
    assert.equal(settings.unrelated, 'keep');
    assert.equal(settings.extensions.length, 1);
    const managed = join(receiver, 'setup-share', 'imports', id, 'resources');
    assert.equal(await readFile(join(managed, 'extension', 'sample.ts'), 'utf8'), 'export default function setup() {}');
    assert.equal(await readFile(join(managed, 'skill', 'craft', 'support.ts'), 'utf8'), 'export const craft = true;');
    assert.equal(await readFile(join(managed, 'prompt', 'hello.md'), 'utf8'), '# Synthetic prompt');
    assert.equal(await readFile(join(managed, 'theme', 'blue.json'), 'utf8'), '{"name":"blue","colors":{}}');
    assert.equal(await readFile(join(receiver, 'setup-share', 'imports', id, 'agents-package', 'agents', 'helper.md'), 'utf8'), '# Synthetic agent');
    assert.equal(await readFile(join(receiver, 'setup-share', 'imports', id, 'agents-package', 'agents', 'support.ts'), 'utf8'), 'export const helper = true;');
    assert.equal(JSON.stringify(settings).includes('support.ts'), false);
    assert.equal(await readFile(join(receiver, 'extensions', 'sample.ts'), 'utf8'), 'ORIGINAL_RECEIVER_EXTENSION');
    await runSetupShare(context([en.restore, options => options[0]!], [], [true]).ctx, receiver, installer, root);
    assert.deepEqual(await listImports(receiverStore), []);
    assert.equal(await readFile(join(receiver, 'settings.json'), 'utf8'), originalSettings);
    assert.equal(await readFile(join(receiver, 'extensions', 'sample.ts'), 'utf8'), 'ORIGINAL_RECEIVER_EXTENSION');
  });
});

test('candidate cap marks the exported report as partial', async () => {
  await fixture(async (root, agent) => {
    const directory = join(agent, 'extensions');
    await mkdir(directory, { recursive: true });
    await Promise.all(Array.from({ length: 257 }, (_, index) =>
      writeFile(join(directory, `extension-${index}.ts`), 'synthetic')));
    const output = join(root, 'partial.zip');
    const ui = context([en.export], [output], [{ count: 5, include: [] }, { count: 256, include: [] }, true], [true, true, false]);
    await runSetupShare(ui.ctx, agent, noInstall, root);
    const transfer = (await readProfileFile(output)).transfer;
    assert.ok(transfer?.partial.includes('extension'));
    assert.equal(transfer?.scanned.includes('extension'), false);
    assert.ok(transfer?.omissions.some(item => item.category === 'resourceFiles' && item.reason === 'excluded'));
  });
});

test('duplicate global resource paths require an explicit source choice', async () => {
  await fixture(async (root, agent) => {
    await mkdir(join(agent, 'skills', 'craft'), { recursive: true });
    await mkdir(join(root, '.agents', 'skills', 'craft'), { recursive: true });
    await writeFile(join(agent, 'skills', 'craft', 'SKILL.md'), 'from Pi');
    await writeFile(join(root, '.agents', 'skills', 'craft', 'SKILL.md'), 'from user');
    const output = join(root, 'choice.zip');
    const ui = context([en.export, options => options[1]!], [output], [
      { count: 5, include: [] }, { count: 2, include: [0, 1] }, true,
    ], [true, true, true, false]);
    await runSetupShare(ui.ctx, agent, noInstall, root);
    assert.deepEqual((await readProfileFile(output)).resources.map(resource => resource.content), ['from user']);
    assert.deepEqual(ui.menus.at(-1), ['Pi skills', 'User skills']);
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

test('conflicts offer skip per item for packages, resources and MCP', async () => {
  await fixture(async (root, agent) => {
    const source = await conflictFixture(root, agent);
    const ui = context([en.import, ...Array.from({ length: 6 }, () => () => en.preserve)], [source],
      [{ count: 1, include: [0] }, { count: 2, include: [1] }, { count: 1, include: [0] }, { count: 1, include: [0] }, true, true, true]);
    await runSetupShare(ui.ctx, agent, isolatedInstaller);
    const conflictMenus = ui.menus.filter(options => options.includes(en.preserve) && options.includes(en.overwrite));
    assert.ok(conflictMenus.length >= 3, JSON.stringify(ui.menus));
    assert.ok(conflictMenus.every(options => options.includes(en.skip)), JSON.stringify(conflictMenus));
  });
});

test('activation coverage report distinguishes preserved, replaced and skipped items', async () => {
  await fixture(async (root, agent) => {
    const source = await conflictFixture(root, agent);
    const ui = context([en.import, () => en.preserve, () => en.overwrite, () => en.skip, () => en.skip], [source],
      [{ count: 1, include: [0] }, { count: 2, include: [1] }, { count: 1, include: [0] }, { count: 1, include: [0] }, true, true, true]);
    await runSetupShare(ui.ctx, agent, isolatedInstaller);
    const screens = ui.screens.join('\n');
    assert.match(screens, /conflict \/ preserve/);
    assert.match(screens, /conflict \/ write/);
    assert.match(screens, /\/ skip/);
    const settings = JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8'));
    assert.equal(settings.quietStartup, false);
    assert.equal(settings.prompts, false);
    assert.deepEqual(settings.packages, [{ source: 'npm:example@9.9.9' }]);
    const mcp = JSON.parse(await readFile(join(agent, 'mcp.json'), 'utf8'));
    assert.deepEqual(mcp.mcpServers.example.args, ['other.js']);
    assert.equal(mcp.mcpServers.example.disabled, true);
  });
});

test('recovery and lock gates still reject instead of resolving as a notification', async () => {
  await fixture(async (root, agent) => {
    const source = join(root, 'profile.json');
    await writeFile(source, JSON.stringify(profile));
    await mkdir(join(agent, 'setup-share'), { recursive: true });
    await writeFile(join(agent, 'setup-share', 'pending.json'), '{}');
    const ui = context([en.import], [source], [{ count: 1, include: [0] }]);
    await assert.rejects(runSetupShare(ui.ctx, agent, noInstall), { code: 'recovery-required' });
    assert.deepEqual(ui.notifications, []);
  });
  await fixture(async (root, agent) => {
    const source = join(root, 'profile.json');
    await writeFile(source, JSON.stringify(profile));
    // A first staged import creates the store owner file, so the lock is the only remaining obstacle.
    await runSetupShare(context([en.import], [source], [{ count: 1, include: [0] }, true, false]).ctx, agent, noInstall);
    await mkdir(join(agent, 'setup-share', 'lock'), { recursive: true });
    const ui = context([en.import], [source], [{ count: 1, include: [0] }, true]);
    await assert.rejects(runSetupShare(ui.ctx, agent, noInstall), { code: 'busy' });
    assert.deepEqual(ui.notifications, []);
  });
});

test('import flow surfaces an installation failure as a notification', async () => {
  await fixture(async (root, agent) => {
    const source = join(root, 'profile.json');
    await writeFile(source, JSON.stringify({ format: 'pi-setup-share', version: 1, resources: [], packages: [{ source: 'npm:example@1.2.3' }] }));
    await runSetupShare(context([en.import], [source], [{ count: 1, include: [0] }, true, false]).ctx, agent, noInstall);
    const failing: PackageInstallerFactory = () => { throw new Error('synthetic private command output'); };
    const ui = context([en.resume, options => options[0]!], [], [true]);
    await runSetupShare(ui.ctx, agent, failing);
    assert.ok(ui.notifications.some(message => message === en.abandoned || message === en.errors['installation-abandoned']));
    assert.equal(ui.notifications.join('').includes('synthetic private command output'), false);
  });
});

test('full import flow renders within 120x40', async () => {
  await fixture(async (root, agent) => {
    const source = join(root, 'profile.json');
    await writeFile(source, JSON.stringify(profile));
    const ui = context([en.import], [source], [{ count: 1, include: [0] }, true, true], [], { width: 120, rows: 40 });
    await runSetupShare(ui.ctx, agent, noInstall);
    assert.ok(ui.screens.some(screen => screen.includes(en.stageTitle)));
    for (const screen of ui.screens) {
      const lines = screen.split('\n');
      assert.ok(lines.length <= 40, JSON.stringify(lines));
      assert.ok(lines.every(line => line.length <= 120), JSON.stringify(lines));
    }
  });
});

test('future profile version is reported without rejecting the TUI promise', async () => {
  await fixture(async (root, agent) => {
    const source = join(root, 'future.json');
    await writeFile(source, JSON.stringify({ format: 'pi-setup-share', version: 99, resources: [] }));
    const ui = context([en.import], [source], []);
    await runSetupShare(ui.ctx, agent, noInstall);
    assert.ok(ui.notifications.includes(en.invalidProfile));
  });
});

test('receiver review lists every manual action of the transfer report', async () => {
  await fixture(async (root, agent) => {
    const source = join(root, 'v2-actions.json');
    const actions = Object.keys(en.receiverActions) as Array<keyof typeof en.receiverActions>;
    await writeFile(source, JSON.stringify({ format: 'pi-setup-share', version: 2, resources: [],
      transfer: { scanned: [], partial: [], notExamined: ['project'], omissions: [], actions },
    }));
    const ui = context([en.inspect], [source], []);
    await runSetupShare(ui.ctx, agent, noInstall);
    const screens = ui.screens.join('\n').replace(/\s+/g, ' ');
    for (const action of actions) assert.ok(screens.includes(en.receiverActions[action]), action);
  });
});
