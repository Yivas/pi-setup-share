import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  advanceSwapJournal, captureIdentity, createSwapPlan, identityMatches, readSwapJournal, recoverSwap, restoreReceiverBackup, runSwap, SWAP_FORMAT, validateSwapJournal, writeSwapJournal,
} from '../src/literal-swap.ts';
import { previewReceiverBackup, writeReceiverBackup } from '../src/literal-backup.ts';
import { digestTree } from '../src/literal-writer.ts';
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

test('runs the deferred swap end to end and keeps every copy', async () => {
  await fixture(async (workspace, agentDir, staging) => {
    const plan = await createSwapPlan(agentDir, staging);
    const journal = await runSwap(plan);
    assert.equal(journal.state, 'success');
    assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), '{"synthetic":"replacement"}\n');
    assert.equal(await readFile(join(journal.rescue, 'settings.json'), 'utf8'), '{"synthetic":true}\n');
    assert.equal((await previewReceiverBackup(journal.backup)).files >= 1, true);
    const receipt = JSON.parse(await readFile(`${plan.journalPath}.receipt.json`, 'utf8'));
    assert.equal(receipt.state, 'success');
    assert.equal(receipt.agentDir, agentDir);
    assert.equal(receipt.digest, journal.stagedDigest);
    assert.equal((await readdir(workspace)).some(name => name.endsWith('.lock')), false);
    assert.deepEqual((await readdir(workspace)).filter(name => name.includes('.tmp')), []);
  });
});

test('an interrupted transition leaves the last completed state and moves nothing', async () => {
  await fixture(async (_workspace, agentDir, staging) => {
    const plan = await createSwapPlan(agentDir, staging);
    await assert.rejects(runSwap(plan, { onTransition: ({ state }) => { if (state === 'backed-up') throw new Error('synthetic interruption'); } }));
    const journal = await readSwapJournal(plan.journalPath);
    assert.equal(journal.state, 'backed-up');
    assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), '{"synthetic":true}\n');
    assert.equal(await lstat(journal.rescue).then(() => true, () => false), false);
    const recovered = await recoverSwap(plan.journalPath);
    assert.equal(recovered.state, 'recovery-required');
    assert.equal(recovered.note?.includes('nothing changed'), true);
  });
});

test('recovery restores the original when the swap stopped between the renames', async () => {
  await fixture(async (_workspace, agentDir, staging) => {
    const plan = await createSwapPlan(agentDir, staging);
    await assert.rejects(runSwap(plan, { onTransition: ({ state }) => { if (state === 'old-moved') throw new Error('synthetic interruption'); } }));
    const interrupted = await readSwapJournal(plan.journalPath);
    assert.equal(interrupted.state, 'old-moved');
    assert.equal(await lstat(agentDir).then(() => true, () => false), false);
    assert.equal((await digestTree(interrupted.rescue)).digest, interrupted.agentDigest);
    const recovered = await recoverSwap(plan.journalPath);
    assert.equal(recovered.state, 'recovery-required');
    assert.equal(recovered.note?.includes('original restored'), true);
    assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), '{"synthetic":true}\n');
    assert.equal(await readFile(join(recovered.backup)).then(bytes => bytes.length > 0), true);
  });
});

test('a failed second rename restores the original and reports recovery-required', async () => {
  await fixture(async (_workspace, agentDir, staging) => {
    const plan = await createSwapPlan(agentDir, staging);
    await assert.rejects(runSwap(plan, { onTransition: async ({ state }) => {
      if (state === 'old-moved') {
        await mkdir(agentDir, { recursive: true });
        await writeFile(join(agentDir, 'blocker.txt'), 'synthetic blocker');
      }
    } }), StorageError);
    const journal = await readSwapJournal(plan.journalPath);
    assert.equal(journal.state, 'recovery-required');
    assert.equal(journal.note?.includes('rescue path'), true);
    assert.equal((await digestTree(journal.rescue)).digest, journal.agentDigest);
  });
});

test('refuses to run while another swap holds the lock', async () => {
  await fixture(async (_workspace, agentDir, staging) => {
    const plan = await createSwapPlan(agentDir, staging);
    await mkdir(`${plan.journalPath}.lock`);
    await assert.rejects(runSwap(plan), { code: 'busy' });
    assert.equal((await readSwapJournal(plan.journalPath)).state, 'staged');
    assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), '{"synthetic":true}\n');
  });
});

test('recovery reports an installed tree without deleting anything', async () => {
  await fixture(async (_workspace, agentDir, staging) => {
    const plan = await createSwapPlan(agentDir, staging);
    const journal = await readSwapJournal(plan.journalPath);
    await writeFile(journal.backup, 'synthetic placeholder backup');
    await lstat(agentDir);
    const { rename } = await import('node:fs/promises');
    await rename(agentDir, journal.rescue);
    await rename(staging, agentDir);
    const recovered = await recoverSwap(plan.journalPath);
    assert.equal(recovered.state, 'recovery-required');
    assert.equal(recovered.note?.includes('new tree installed'), true);
    assert.equal(await lstat(journal.rescue).then(() => true, () => false), true);
    assert.equal(await lstat(journal.backup).then(() => true, () => false), true);
    assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), '{"synthetic":"replacement"}\n');
  });
});

test('restores a verified receiver backup over the agent directory', async () => {
  await fixture(async (workspace, agentDir) => {
    const backup = join(workspace, 'receiver-backup.zip');
    await writeReceiverBackup(agentDir, backup);
    await writeFile(join(agentDir, 'settings.json'), '{"synthetic":"later state"}\n');
    const journal = await restoreReceiverBackup(backup, agentDir);
    assert.equal(journal.state, 'success');
    assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), '{"synthetic":true}\n');
    assert.equal(await readFile(join(journal.rescue, 'settings.json'), 'utf8'), '{"synthetic":"later state"}\n');
    assert.equal((await previewReceiverBackup(journal.backup)).files >= 1, true);
    const receipt = JSON.parse(await readFile(`${journal.agentDir}.swap-${journal.id}.json.receipt.json`, 'utf8'));
    assert.equal(receipt.state, 'success');
  });
});

test('refuses an altered backup or a literal archive without touching the destination', async () => {
  await fixture(async (workspace, agentDir) => {
    const backup = join(workspace, 'receiver-backup.zip');
    await writeReceiverBackup(agentDir, backup);
    const original = await readFile(backup);
    const altered = Buffer.from(original);
    altered[altered.length - 60] = (altered[altered.length - 60] ?? 0) ^ 1;
    const alteredPath = join(workspace, 'altered.zip');
    await writeFile(alteredPath, altered);
    const before = await readFile(join(agentDir, 'settings.json'), 'utf8');
    await assert.rejects(restoreReceiverBackup(alteredPath, agentDir), StorageError);
    assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), before);
    assert.deepEqual((await readdir(workspace)).filter(name => name.includes('.restore-')), []);
    const { writeLiteralArchive } = await import('../src/literal-writer.ts');
    const literal = join(workspace, 'literal.zip');
    await writeLiteralArchive(agentDir, literal);
    await assert.rejects(restoreReceiverBackup(literal, agentDir), StorageError);
    assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), before);
  });
});
