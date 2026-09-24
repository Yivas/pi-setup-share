import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  advanceSwapJournal, captureIdentity, createSwapPlan, identityMatches, preflightSwap, readSwapJournal, recoverSwap, restoreReceiverBackup, runSwap, SWAP_FORMAT, validateSwapJournal, writeSwapJournal,
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

test('preflights the swap without writing anything', async () => {
  await fixture(async (workspace, agentDir, staging) => {
    const before = (await readdir(workspace)).sort();
    const report = await preflightSwap(agentDir, staging);
    assert.equal(report.ok, true);
    assert.deepEqual(report.reasons, []);
    assert.equal(report.agentFiles, 1);
    assert.equal(report.stagedFiles, 1);
    assert.equal(report.agentBytes, Buffer.byteLength('{"synthetic":true}\n'));
    assert.equal(report.stagedBytes, Buffer.byteLength('{"synthetic":"replacement"}\n'));
    assert.equal(report.freeBytes > 0, true);
    assert.deepEqual((await readdir(workspace)).sort(), before);
  });
});

test('preflight reports unreadable trees and insufficient space', async () => {
  await fixture(async (workspace, agentDir, staging) => {
    const missingStaging = await preflightSwap(agentDir, join(workspace, 'missing'));
    assert.equal(missingStaging.ok, false);
    assert.deepEqual(missingStaging.reasons, ['unreadable-staging']);
    const missingRoot = await preflightSwap(join(workspace, 'missing'), staging);
    assert.deepEqual(missingRoot.reasons, ['unreadable-root']);
    const tight = await preflightSwap(agentDir, staging, { extraBytes: 10 * 1024 ** 4 });
    assert.equal(tight.ok, false);
    assert.deepEqual(tight.reasons, ['insufficient-space']);
    assert.equal(tight.requiredBytes > 10 * 1024 ** 4, true);
  });
});

// POSIX permission fixtures: chmod does not deny writes on Windows, and a root container ignores mode.
const posixPermissions = process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);
const posixSkip = posixPermissions ? 'mode bits do not deny access here' : false;

test('a destination that cannot be written aborts before touching any tree', { skip: posixSkip }, async () => {
  await fixture(async (workspace, agentDir, staging) => {
    const plan = await createSwapPlan(agentDir, staging);
    await chmod(workspace, 0o500);
    try {
      await assert.rejects(runSwap(plan), StorageError);
      const journal = await readSwapJournal(plan.journalPath);
      assert.notEqual(journal.state, 'success');
      assert.equal(await lstat(plan.journal.rescue).then(() => true, () => false), false);
      assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), '{"synthetic":true}\n');
      assert.equal(await readFile(join(staging, 'settings.json'), 'utf8'), '{"synthetic":"replacement"}\n');
    } finally {
      await chmod(workspace, 0o700);
    }
  });
});

test('preflight reports a staging tree it cannot read', { skip: posixSkip }, async () => {
  await fixture(async (_workspace, agentDir, staging) => {
    await chmod(staging, 0o000);
    try {
      const report = await preflightSwap(agentDir, staging);
      assert.equal(report.ok, false);
      assert.equal(report.reasons.includes('unreadable-staging'), true);
    } finally {
      await chmod(staging, 0o700);
    }
  });
});

test('preflight reports an unreadable root as well', { skip: posixSkip }, async () => {
  await fixture(async (_workspace, agentDir, staging) => {
    await chmod(agentDir, 0o000);
    try {
      const report = await preflightSwap(agentDir, staging);
      assert.equal(report.ok, false);
      assert.equal(report.reasons.includes('unreadable-root'), true);
    } finally {
      await chmod(agentDir, 0o700);
    }
  });
});

test('cancellation during the backup aborts before any rename', async () => {
  await fixture(async (workspace, agentDir, staging) => {
    const plan = await createSwapPlan(agentDir, staging);
    const controller = new AbortController();
    await assert.rejects(runSwap(plan, { signal: controller.signal, onTransition: ({ state }) => {
      if (state === 'exited') controller.abort();
    } }), { code: 'aborted' });
    const journal = await readSwapJournal(plan.journalPath);
    assert.equal(journal.state, 'exited');
    assert.equal(await lstat(journal.rescue).then(() => true, () => false), false);
    assert.equal(await lstat(journal.backup).then(() => true, () => false), false);
    assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), '{"synthetic":true}\n');
    assert.equal(await readFile(join(staging, 'settings.json'), 'utf8'), '{"synthetic":"replacement"}\n');
    assert.equal((await readdir(workspace)).some(name => name.endsWith('.lock')), false);
  });
});

test('a lost journal stops the swap with the original intact and refuses automatic recovery', async () => {
  await fixture(async (_workspace, agentDir, staging) => {
    const plan = await createSwapPlan(agentDir, staging);
    const { unlink } = await import('node:fs/promises');
    await assert.rejects(runSwap(plan, { onTransition: async ({ state }) => {
      if (state === 'exited') await unlink(plan.journalPath);
    } }), StorageError);
    const gone = await lstat(plan.journalPath).then(() => true, () => false);
    assert.equal(gone, false);
    assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), '{"synthetic":true}\n');
    assert.equal(await lstat(plan.journal.rescue).then(() => true, () => false), false);
    await assert.rejects(recoverSwap(plan.journalPath), StorageError);
  });
});

test('a receipt that cannot be written never contradicts the journal', async () => {
  await fixture(async (_workspace, agentDir, staging) => {
    const plan = await createSwapPlan(agentDir, staging);
    const receiptPath = `${plan.journalPath}.receipt.json`;
    await mkdir(receiptPath);
    await assert.rejects(runSwap(plan), StorageError);
    const journal = await readSwapJournal(plan.journalPath);
    assert.equal(journal.state, 'success');
    assert.equal((await lstat(receiptPath)).isDirectory(), true);
    assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), '{"synthetic":"replacement"}\n');
    assert.equal(await readFile(join(journal.rescue, 'settings.json'), 'utf8'), '{"synthetic":true}\n');
    assert.deepEqual((await readdir(dirname(plan.journalPath))).filter(name => name.includes('.tmp')), []);
  });
});

test('a completed swap cannot run again over the same plan', async () => {
  await fixture(async (_workspace, agentDir, staging) => {
    const plan = await createSwapPlan(agentDir, staging);
    await runSwap(plan);
    const installed = await readFile(join(agentDir, 'settings.json'), 'utf8');
    await assert.rejects(runSwap(plan), StorageError);
    assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), installed);
    assert.equal((await readSwapJournal(plan.journalPath)).state, 'success');
  });
});
