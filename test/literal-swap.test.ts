import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  advanceSwapJournal, captureIdentity, createSwapPlan, identityMatches, readSwapJournal, SWAP_FORMAT, validateSwapJournal, writeSwapJournal,
} from '../src/literal-swap.ts';
import { StorageError } from '../src/storage.ts';
import { lstat } from 'node:fs/promises';

async function fixture(run: (workspace: string, agentDir: string, staging: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'pi-literal-swap-'));
  const agentDir = join(workspace, 'agent');
  const staging = join(workspace, 'staged');
  await mkdir(join(agentDir, 'sessions'), { recursive: true });
  await writeFile(join(agentDir, 'settings.json'), '{"synthetic":true}\n');
  await mkdir(staging);
  await writeFile(join(staging, 'settings.json'), '{"synthetic":"replacement"}\n');
  try { await run(workspace, agentDir, staging); } finally { await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

test('creates a staged plan with sibling paths and matching identities', async () => {
  await fixture(async (_workspace, agentDir, staging) => {
    const plan = await createSwapPlan(agentDir, staging);
    const journal = await readSwapJournal(plan.journalPath);
    assert.equal(journal.state, 'staged');
    assert.equal(journal.format, SWAP_FORMAT);
    assert.equal(journal.agentDir, agentDir);
    assert.equal(journal.staging, staging);
    assert.equal(identityMatches(plan.agentIdentity, await lstat(agentDir)), true);
    assert.equal(identityMatches(plan.stagingIdentity, await lstat(staging)), true);
    for (const path of [journal.rescue, journal.backup]) {
      assert.equal(path.startsWith(`${agentDir}/`) || path.startsWith(`${agentDir}\\`), false);
      assert.equal(await lstat(path).then(() => true, () => false), false);
    }
    assert.deepEqual((await readdir(agentDir)).sort(), ['sessions', 'settings.json']);
    const leftovers = (await readdir(_workspace)).filter(name => name.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

test('refuses missing trees, linked roots and equal paths', async () => {
  await fixture(async (workspace, agentDir, staging) => {
    await assert.rejects(createSwapPlan(agentDir, join(workspace, 'missing')), { code: 'unsafe-path' });
    await assert.rejects(createSwapPlan(agentDir, agentDir), { code: 'unsafe-path' });
    const linked = join(workspace, 'linked-agent');
    await symlink(agentDir, linked, process.platform === 'win32' ? 'junction' : 'dir');
    if ((await lstat(linked)).isSymbolicLink()) {
      await assert.rejects(createSwapPlan(linked, staging), { code: 'unsafe-path' });
    }
    const plan = await createSwapPlan(agentDir, staging);
    assert.equal(plan.journal.state, 'staged');
    assert.equal(JSON.parse(await readFile(plan.journalPath, 'utf8')).agentDir, agentDir);
  });
});

test('validates the journal strictly and advances it with a matching id', async () => {
  await fixture(async (_workspace, agentDir, staging) => {
    const plan = await createSwapPlan(agentDir, staging);
    const journal = await readSwapJournal(plan.journalPath);
    const base = { ...journal };
    assert.throws(() => validateSwapJournal({ ...base, format: 'other' }), StorageError);
    assert.throws(() => validateSwapJournal({ ...base, state: 'invented' }), StorageError);
    assert.throws(() => validateSwapJournal({ ...base, staging: 'relative/path' }), StorageError);
    assert.throws(() => validateSwapJournal({ ...base, rescue: base.staging }), StorageError);
    assert.throws(() => validateSwapJournal({ ...base, rescue: `${base.agentDir}/inside` }), StorageError);
    assert.throws(() => validateSwapJournal({ ...base, agentIdentity: { dev: 'x', ino: '1', mtimeMs: '1' } }), StorageError);
    assert.throws(() => validateSwapJournal({ ...base, note: 'x'.repeat(513) }), StorageError);
    const advanced = await advanceSwapJournal(plan, 'armed');
    assert.equal(advanced.state, 'armed');
    assert.equal((await readSwapJournal(plan.journalPath)).state, 'armed');
    const other = await createSwapPlan(join(agentDir, '..', 'agent'), staging);
    await writeFile(plan.journalPath, JSON.stringify({ ...other.journal }));
    await assert.rejects(advanceSwapJournal(plan, 'exited'), { code: 'invalid-state' });
  });
});

test('writes journals atomically and reports unavailable paths without leaving temporaries', async () => {
  await fixture(async (workspace, agentDir, staging) => {
    const plan = await createSwapPlan(agentDir, staging);
    const missing = join(workspace, 'no-such-directory', 'journal.json');
    await assert.rejects(writeSwapJournal(missing, plan.journal), { code: 'unavailable' });
    assert.deepEqual((await readdir(workspace)).filter(name => name.includes('.tmp')), []);
    const bytes = await readFile(plan.journalPath, 'utf8');
    assert.equal(bytes.includes('synthetic'), false);
    const stats = await lstat(plan.journalPath);
    assert.equal(stats.isFile(), true);
    assert.deepEqual(captureIdentity(await lstat(staging)), plan.stagingIdentity);
  });
});
