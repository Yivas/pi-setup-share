import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('native Pi loads and registers setup-share without factory I/O or model use', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-setup-share-extension-'));
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key];
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TEMP', 'TMP']) env[key] = root;
    Object.assign(env, { PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', COLORTERM: 'truecolor', TERM: 'xterm-256color' });
    const entry = new URL('../src/index.ts', import.meta.url).href;
    const components = new URL('../src/ui-components.ts', import.meta.url).href;
    const locale = new URL('../src/locales/en.ts', import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import { readdir, writeFile } from 'node:fs/promises';
      import setupShare from ${JSON.stringify(entry)};
      import { reviewComponent, selectionComponent, confirmStep } from ${JSON.stringify(components)};
      import { en } from ${JSON.stringify(locale)};
      export default async function (pi) {
        const before = await readdir(process.cwd());
        let registered;
        setupShare({ registerCommand(name, command) { assert.equal(name, 'setup-share'); registered = command; } });
        await registered.handler('', { mode: 'rpc', hasUI: true });
        await registered.handler('', { mode: 'tui', hasUI: true, ui: { select: async () => undefined } });
        setupShare(pi);
        assert.deepEqual(await readdir(process.cwd()), before);
        pi.on('session_start', async (_event, ctx) => {
          assert.ok(pi.getCommands().some(command => command.name === 'setup-share'));
          const renders = [];
          for (const [width, rows] of [[80, 24], [120, 40]]) {
            const tui = { terminal: { rows }, requestRender() {} };
            const review = reviewComponent(tui, ctx.ui.theme, () => {}, ['Synthetic profile', 'Resources: 2', 'Packages: 1', 'preferences.quietStartup: true', 'No resource code is executed during review.']);
            const omission = reviewComponent(tui, ctx.ui.theme, () => {}, [en.omittedMcpTitle, 'localOnly: ' + en.omittedMcpReason]);
            const selection = selectionComponent(tui, ctx.ui.theme, () => {}, [{ value: '0', label: 'Portable MCP A' }, { value: '1', label: 'Portable MCP B' }], en.selectAllPortableMcp);
            renders.push(width + 'x' + rows, ...review.render(width), '', ...omission.render(width), '', ...selection.render(width));
            for (const [title, warning] of [[en.stageTitle, en.stageWarning], [en.installTitle, en.installWarning], [en.activateTitle, en.activateWarning], [en.restoreTitle, en.restoreWarning], [en.recoveryTitle, en.recoveryWarning]]) {
              await confirmStep({ ui: { custom: factory => new Promise(resolve => {
                const component = factory(tui, ctx.ui.theme, {}, resolve);
                const lines = component.render(width);
                assert.ok(lines.length <= rows);
                renders.push('', ...lines);
                component.handleInput('\\x1b');
              }) } }, title, warning);
            }
          }
          await writeFile('render.txt', renders.join('\\n'));
          process.stderr.write('native extension passed\\n', () => process.exit(0));
        });
      }
    `;
    const probe = join(root, 'probe.ts');
    await writeFile(probe, script);
    const sdkRoot = new URL('../node_modules/@earendil-works/pi-coding-agent/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('package.json', sdkRoot), 'utf8'));
    const cli = fileURLToPath(new URL(manifest.bin.pi, sdkRoot));
    const result = await execute(process.execPath, [cli, '--no-session', '--no-context-files', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '-e', probe, '--mode', 'rpc'], { cwd: root, env, timeout: 20_000, maxBuffer: 64 * 1024 });
    assert.equal(result.stderr.trim(), 'native extension passed');
    assert.equal(result.stdout, '');
    const render = await readFile(join(root, 'render.txt'), 'utf8');
    assert.match(render, /80x24/);
    assert.match(render, /120x40/);
    assert.match(render, /Select all portable MCP servers/);
    assert.match(render, /localOnly: Not portable/);
    t.assert.snapshot(render);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});
