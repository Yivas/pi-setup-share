import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('the adapter loads in native Pi and uses only the supplied store and in-memory settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-setup-share-sdk-'));
  try {
    await mkdir(join(root, 'npm/node_modules/synthetic-one'), { recursive: true });
    await writeFile(join(root, 'settings.json'), '{"packages":["npm:must-not-load@1.0.0"]}\n');
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key];
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TEMP', 'TMP']) env[key] = root;
    Object.assign(env, { PI_CODING_AGENT_DIR: join(root, 'unused-agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' });
    const adapter = new URL('../src/pi-installer.ts', import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import { readFile, readdir } from 'node:fs/promises';
      import { join } from 'node:path';
      import { createPackageInstaller } from ${JSON.stringify(adapter)};
      export default async function () {
      const before = await readdir(process.cwd());
      const installer = createPackageInstaller(process.cwd());
      assert.deepEqual(installer.listConfiguredPackages(), []);
      assert.equal(installer.getInstalledPath('npm:synthetic-one@1.2.3', 'user'), join(process.cwd(), 'npm/node_modules/synthetic-one'));
      assert.equal(await readFile('settings.json', 'utf8'), '{"packages":["npm:must-not-load@1.0.0"]}\\n');
      assert.deepEqual(await readdir(process.cwd()), before);
      process.stderr.write('isolated adapter passed\\n', () => process.exit(0));
      }
    `;
    const probe = join(root, 'probe.ts');
    await writeFile(probe, script);
    const sdkRoot = new URL('../node_modules/@earendil-works/pi-coding-agent/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('package.json', sdkRoot), 'utf8'));
    const cli = fileURLToPath(new URL(manifest.bin.pi, sdkRoot));
    const result = await execute(process.execPath, [cli, '--no-session', '--no-context-files', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '-e', probe, '--mode', 'rpc'], { cwd: root, env, timeout: 20_000, maxBuffer: 64 * 1024 });
    assert.equal(result.stderr.trim(), 'isolated adapter passed');
    assert.equal(result.stdout, '');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
