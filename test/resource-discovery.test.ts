import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverGlobalResources } from '../src/resource-discovery.ts';

test('keeps same relative skill from distinct roots available with origin', async () => {
  const home = await mkdtemp(join(tmpdir(), 'setup-share-home-'));
  try {
    const agentDir = join(home, 'pi-agent');
    await mkdir(join(agentDir, 'skills', 'craft'), { recursive: true });
    await mkdir(join(home, '.agents', 'skills', 'craft'), { recursive: true });
    await writeFile(join(agentDir, 'skills', 'craft', 'SKILL.md'), 'from Pi');
    await writeFile(join(home, '.agents', 'skills', 'craft', 'SKILL.md'), 'from user');
    const inventory = await discoverGlobalResources(agentDir, home);
    assert.deepEqual(inventory.items.map(item => [item.origin, item.candidate.path]),
      [['Pi skills', 'craft/SKILL.md'], ['User skills', 'craft/SKILL.md']]);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('discovers known user roots without reading or including sensitive files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'setup-share-home-'));
  try {
    const agentDir = join(home, 'pi-agent');
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await mkdir(join(agentDir, 'skills', 'craft'), { recursive: true });
    await mkdir(join(agentDir, 'prompts'), { recursive: true });
    await mkdir(join(agentDir, 'themes'), { recursive: true });
    await mkdir(join(agentDir, 'agents'), { recursive: true });
    await mkdir(join(home, '.agents', 'skills', 'external'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'mine.ts'), 'synthetic extension');
    await writeFile(join(agentDir, 'skills', 'craft', 'SKILL.md'), 'synthetic skill');
    await writeFile(join(agentDir, 'prompts', 'hello.md'), 'synthetic prompt');
    await writeFile(join(agentDir, 'themes', 'custom.json'), '{}');
    await writeFile(join(agentDir, 'agents', 'helper.md'), 'synthetic agent');
    await writeFile(join(home, '.agents', 'skills', 'external', 'SKILL.md'), 'external skill');
    await writeFile(join(agentDir, 'skills', 'craft', '.env'), 'synthetic-secret');
    const inventory = await discoverGlobalResources(agentDir, home);
    assert.deepEqual(inventory.items.map(item => `${item.candidate.kind}:${item.candidate.path}`).sort(), [
      'agent:helper.md', 'extension:mine.ts', 'prompt:hello.md', 'skill:craft/SKILL.md',
      'skill:external/SKILL.md', 'theme:custom.json',
    ]);
    assert.equal(inventory.omitted, 1);
    assert.equal(JSON.stringify(inventory).includes('synthetic-secret'), false);
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});
