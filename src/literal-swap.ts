// Deferred-swap journal and plan for the literal mode. The journal lives outside the directory being
// replaced, stores identities and protected paths but never secret bytes, and is written atomically so
// an interrupted transition can be recognized instead of guessed. Nothing here swaps anything yet: the
// post-exit auxiliary state machine builds on this contract.
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rmdir, statfs, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { materializeReceiverBackup, previewReceiverBackup, writeReceiverBackup } from './literal-backup.ts';
import { LITERAL_ARCHIVE_SPEC } from './literal-manifest.ts';
import { digestTree, type TreeDigest } from './literal-writer.ts';
import { StorageError } from './storage.ts';

export const SWAP_FORMAT = 'pi-setup-share-literal-swap' as const;
export const SWAP_STATES = ['staged', 'armed', 'exited', 'backed-up', 'old-moved', 'new-moved', 'verified', 'success', 'recovery-required'] as const;
export type SwapState = (typeof SWAP_STATES)[number];

export type SwapIdentity = Readonly<{ dev: string; ino: string; mtimeMs: string }>;
export type SwapJournal = Readonly<{
  format: typeof SWAP_FORMAT;
  version: 1;
  id: string;
  state: SwapState;
  agentDir: string;
  staging: string;
  rescue: string;
  backup: string;
  agentIdentity: SwapIdentity;
  stagingIdentity: SwapIdentity;
  agentDigest: string;
  stagedDigest: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
}>;

const JOURNAL_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
const JOURNAL_KEYS = ['format', 'version', 'id', 'state', 'agentDir', 'staging', 'rescue', 'backup',
  'agentIdentity', 'stagingIdentity', 'agentDigest', 'stagedDigest', 'createdAt', 'updatedAt', 'note'] as const;
// Only these transitions can be written; a tampered journal cannot skip a durable step.
const SWAP_ORDER: Record<SwapState, readonly SwapState[]> = {
  staged: ['armed', 'exited', 'recovery-required'],
  armed: ['exited', 'recovery-required'],
  exited: ['backed-up', 'recovery-required'],
  'backed-up': ['old-moved', 'recovery-required'],
  'old-moved': ['new-moved', 'recovery-required'],
  'new-moved': ['verified', 'recovery-required'],
  verified: ['success', 'recovery-required'],
  success: [],
  'recovery-required': ['recovery-required'],
};

function invalid(): never { throw new StorageError('invalid-state'); }
function unsafe(): never { throw new StorageError('unsafe-path'); }

// Windows compares paths without case, so relationship checks must fold case there: otherwise a nested path
// written with different capitalisation would look separate from its parent, which is exactly the check that
// keeps the staging tree and the rescue paths apart from the directory being replaced.
function folded(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function inside(child: string, parent: string): boolean {
  const nested = folded(child);
  const container = folded(parent);
  return nested.startsWith(`${container}/`) || nested.startsWith(`${container}\\`);
}

function sameDirectory(left: string, right: string): boolean {
  return folded(dirname(left)) === folded(dirname(right));
}

function checkedPath(value: unknown): string {
  if (typeof value !== 'string' || !value || !isAbsolute(value) || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
      || /[\p{C}]/u.test(value) || value !== value.normalize('NFC')) unsafe();
  // Reject aliases: a path must already be canonical, so sibling and separation checks cannot be fooled
  // by '.', '..', doubled or mixed separators or a trailing separator.
  if (normalize(value) !== value) unsafe();
  return value;
}

function checkedIdentity(value: unknown): SwapIdentity {
  if (value === null || typeof value !== 'object') invalid();
  const candidate = value as Record<string, unknown>;
  const { dev, ino, mtimeMs } = candidate;
  if (typeof dev !== 'string' || typeof ino !== 'string' || typeof mtimeMs !== 'string'
      || !/^\d+$/.test(dev) || !/^\d+$/.test(ino) || !/^\d+(?:\.\d+)?$/.test(mtimeMs)) invalid();
  return Object.freeze({ dev, ino, mtimeMs });
}

function checkedDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid();
  return value;
}

// The journal is data, so it is validated as strictly as any other persisted contract.
export function validateSwapJournal(value: unknown): SwapJournal {
  if (value === null || typeof value !== 'object') invalid();
  const candidate = value as Record<string, unknown>;
  if (candidate.format !== SWAP_FORMAT || candidate.version !== 1) invalid();
  if (typeof candidate.id !== 'string' || !/^[0-9a-f-]{36}$/.test(candidate.id)) invalid();
  if (typeof candidate.state !== 'string' || !(SWAP_STATES as readonly string[]).includes(candidate.state)) invalid();
  for (const key of Object.keys(candidate)) {
    if (!(JOURNAL_KEYS as readonly string[]).includes(key)) invalid();
  }
  const agentDir = checkedPath(candidate.agentDir);
  const staging = checkedPath(candidate.staging);
  const rescue = checkedPath(candidate.rescue);
  const backup = checkedPath(candidate.backup);
  if (new Set([agentDir, staging, rescue, backup]).size !== 4) invalid();
  // Rescue, backup and journal are siblings of the root being replaced, never inside it.
  for (const path of [rescue, backup]) {
    if (inside(path, agentDir)) unsafe();
    if (!sameDirectory(path, agentDir)) unsafe();
  }
  // The staged tree is separate from the root it will replace.
  if (inside(staging, agentDir) || inside(agentDir, staging)) unsafe();
  for (const [field, timestamp] of [['createdAt', candidate.createdAt], ['updatedAt', candidate.updatedAt]] as const) {
    if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) invalid();
  }
  const note = candidate.note;
  if (note !== undefined && (typeof note !== 'string' || Buffer.byteLength(note, 'utf8') > 512)) invalid();
  const journal: SwapJournal = Object.freeze({
    format: SWAP_FORMAT, version: 1, id: candidate.id, state: candidate.state as SwapState,
    agentDir, staging, rescue, backup,
    agentIdentity: checkedIdentity(candidate.agentIdentity),
    stagingIdentity: checkedIdentity(candidate.stagingIdentity),
    agentDigest: checkedDigest(candidate.agentDigest),
    stagedDigest: checkedDigest(candidate.stagedDigest),
    createdAt: candidate.createdAt as string, updatedAt: candidate.updatedAt as string,
    ...(note === undefined ? {} : { note }),
  });
  return journal;
}

export function captureIdentity(stats: Stats): SwapIdentity {
  if (!Number.isFinite(stats.dev) || !Number.isFinite(stats.ino) || !Number.isFinite(stats.mtimeMs)) invalid();
  return Object.freeze({ dev: String(stats.dev), ino: String(stats.ino), mtimeMs: String(stats.mtimeMs) });
}

export function identityMatches(identity: SwapIdentity, stats: Stats): boolean {
  return identity.dev === String(stats.dev) && identity.ino === String(stats.ino) && identity.mtimeMs === String(stats.mtimeMs);
}

export async function readSwapJournal(path: string): Promise<SwapJournal> {
  const bytes = await readFile(path).catch(() => invalid());
  if (bytes.length === 0 || bytes.length > JOURNAL_BYTES) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { invalid(); }
  return validateSwapJournal(parsed);
}

// Atomic write: an exclusively created temporary is renamed over the journal in one step.
export async function writeSwapJournal(path: string, journal: SwapJournal): Promise<void> {
  const validated = validateSwapJournal(journal);
  const bytes = Buffer.from(JSON.stringify(validated), 'utf8');
  if (bytes.length > JOURNAL_BYTES) throw new StorageError('limit-exceeded');
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.write(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error instanceof StorageError) throw error;
    throw new StorageError('unavailable');
  }
}

export type SwapPlan = Readonly<{ journalPath: string; journal: SwapJournal; agentIdentity: SwapIdentity; stagingIdentity: SwapIdentity }>;

// The post-exit auxiliary runs in a different process, so it rebuilds the plan from the journal on disk.
export async function loadSwapPlan(journalPath: string): Promise<SwapPlan> {
  const journal = await readSwapJournal(journalPath);
  return Object.freeze({ journalPath, journal, agentIdentity: journal.agentIdentity, stagingIdentity: journal.stagingIdentity });
}

function siblingPath(agentDir: string, suffix: string): string {
  return join(dirname(agentDir), `${agentDir.slice(dirname(agentDir).length + 1)}${suffix}`);
}

// Prepares the plan without touching either tree: it only checks identities and writes the journal.
export async function createSwapPlan(agentDir: string, staging: string): Promise<SwapPlan> {
  const root = checkedPath(agentDir);
  const staged = checkedPath(staging);
  if (root === staged) unsafe();
  const rootStats = await lstat(root).catch(() => unsafe());
  const stagingStats = await lstat(staged).catch(() => unsafe());
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) unsafe();
  if (!stagingStats.isDirectory() || stagingStats.isSymbolicLink()) unsafe();
  const id = randomUUID();
  const rescue = siblingPath(root, `.rescue-${id}`);
  const backup = siblingPath(root, `.backup-${id}.zip`);
  const journalPath = siblingPath(root, `.swap-${id}.json`);
  for (const path of [rescue, backup, journalPath]) {
    if (await lstat(path).then(() => true, () => false)) unsafe();
  }
  const agentDigest = await digestTree(root);
  const stagedDigest = await digestTree(staged);
  const now = new Date().toISOString();
  const journal: SwapJournal = Object.freeze({
    format: SWAP_FORMAT, version: 1, id, state: 'staged',
    agentDir: root, staging: staged, rescue, backup,
    agentIdentity: captureIdentity(rootStats), stagingIdentity: captureIdentity(stagingStats),
    agentDigest: agentDigest.digest, stagedDigest: stagedDigest.digest,
    createdAt: now, updatedAt: now,
  });
  await writeSwapJournal(journalPath, journal);
  return Object.freeze({ journalPath, journal, agentIdentity: journal.agentIdentity, stagingIdentity: journal.stagingIdentity });
}

// Re-reads the journal and the filesystem before any transition; a mismatch is never guessed away.
export async function advanceSwapJournal(plan: SwapPlan, state: SwapState, note?: string): Promise<SwapJournal> {
  return advanceAt(plan.journalPath, plan.journal.id, state, note);
}

async function advanceAt(journalPath: string, expectedId: string, state: SwapState, note?: string): Promise<SwapJournal> {
  const bytes = await readFile(journalPath).catch(() => invalid());
  const current = validateSwapJournal(JSON.parse(bytes.toString('utf8')));
  if (current.id !== expectedId) invalid();
  if (!SWAP_ORDER[current.state].includes(state)) invalid();
  const next: SwapJournal = Object.freeze({
    ...current, state, updatedAt: new Date().toISOString(),
    ...(note === undefined ? {} : { note }),
  });
  await writeSwapJournal(journalPath, next);
  return next;
}

export type SwapProgress = Readonly<{ state: SwapState; note?: string }>;
export type SwapRunOptions = Readonly<{
  signal?: AbortSignal;
  // Persist or display a transition; the auxiliary uses it for progress and the tests inject failures.
  onTransition?: (progress: SwapProgress) => Promise<void> | void;
}>;
export type SwapReceipt = Readonly<{ format: typeof SWAP_FORMAT; version: 1; id: string; state: SwapState;
  agentDir: string; rescue: string; backup: string; digest: string; at: string; note?: string }>;

function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new StorageError('aborted'); }

async function writeJsonAtomic(path: string, value: unknown, limit = JOURNAL_BYTES): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (bytes.length > limit) throw new StorageError('limit-exceeded');
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.write(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error instanceof StorageError) throw error;
    throw new StorageError('unavailable');
  }
}

async function transition(plan: SwapPlan, state: SwapState, options: SwapRunOptions, note?: string): Promise<SwapJournal> {
  const journal = await advanceAt(plan.journalPath, plan.journal.id, state, note);
  await options.onTransition?.({ state, ...(note === undefined ? {} : { note }) });
  return journal;
}

async function fail(plan: SwapPlan, options: SwapRunOptions, note: string): Promise<never> {
  await transition(plan, 'recovery-required', options, note);
  throw new StorageError('recovery-required');
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

// The post-exit auxiliary: verify the trees, back the receiver up and verify it, then two renames with
// a verification after each. It never deletes the original, the backup or the rescue copy, and any
// doubt ends as recovery-required instead of a reported success.
export async function runSwap(plan: SwapPlan, options: SwapRunOptions = {}): Promise<SwapJournal> {
  const lockPath = `${plan.journalPath}.lock`;
  try { await mkdir(lockPath, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new StorageError('busy');
    throw new StorageError('unavailable');
  }
  try {
    checkAbort(options.signal);
    const journal = await readSwapJournal(plan.journalPath);
    if (journal.id !== plan.journal.id) invalid();
    if (journal.state !== 'staged' && journal.state !== 'armed') invalid();
    await transition(plan, 'exited', options);
    const agentStats = await lstat(journal.agentDir).catch(() => invalid());
    const stagingStats = await lstat(journal.staging).catch(() => invalid());
    if (!identityMatches(journal.agentIdentity, agentStats) || !identityMatches(journal.stagingIdentity, stagingStats)) {
      await fail(plan, options, 'trees changed since the plan was written');
    }
    if ((await digestTree(journal.agentDir)).digest !== journal.agentDigest) {
      await fail(plan, options, 'agent directory changed since the plan was written');
    }
    try {
      const backupOptions = options.signal ? { signal: options.signal } : {};
      await writeReceiverBackup(journal.agentDir, journal.backup, backupOptions);
      await previewReceiverBackup(journal.backup, backupOptions);
    } catch (error) {
      if (error instanceof StorageError && error.code === 'aborted') throw error;
      await fail(plan, options, 'receiver backup could not be created and verified');
    }
    await transition(plan, 'backed-up', options);
    await rename(journal.agentDir, journal.rescue);
    await transition(plan, 'old-moved', options);
    if (!identityMatches(journal.agentIdentity, await lstat(journal.rescue))) {
      await fail(plan, options, 'rescue does not hold the original tree');
    }
    try {
      await rename(journal.staging, journal.agentDir);
    } catch (error) {
      // The root is missing at this point, so try to put the original back before reporting.
      try {
        await rename(journal.rescue, journal.agentDir);
        await transition(plan, 'recovery-required', options, 'swap failed after the first rename; original restored');
      } catch {
        await transition(plan, 'recovery-required', options, 'swap failed after the first rename; original preserved at the rescue path');
      }
      throw error instanceof StorageError ? error : new StorageError('invalid-state');
    }
    await transition(plan, 'new-moved', options);
    const installed = await digestTree(journal.agentDir);
    if (installed.digest !== journal.stagedDigest) {
      await fail(plan, options, 'installed tree does not match the staged tree');
    }
    await transition(plan, 'verified', options);
    // The receipt is published only after the durable transition, so it can never claim a state the
    // journal did not confirm. If the receipt cannot be written, the journal already says success and
    // the caller learns about the missing receipt instead of getting a silent mismatch.
    const success = await transition(plan, 'success', options);
    const receipt: SwapReceipt = {
      format: SWAP_FORMAT, version: 1, id: journal.id, state: 'success', agentDir: journal.agentDir,
      rescue: journal.rescue, backup: journal.backup, digest: installed.digest, at: new Date().toISOString(),
    };
    await writeJsonAtomic(`${plan.journalPath}.receipt.json`, receipt);
    return success;
  } finally {
    // A stale lock is a state for the operator to confirm; it is never removed silently here.
    await rmdir(lockPath).catch(() => undefined);
  }
}

// Conservative recovery: it compares the journal with the filesystem, restores only when the identity
// and digest prove it, and otherwise reports what it found without touching anything.
export async function recoverSwap(journalPath: string, options: SwapRunOptions = {}): Promise<SwapJournal> {
  checkAbort(options.signal);
  const journal = await readSwapJournal(journalPath);
  if (!await exists(journal.backup)) {
    return advanceAt(journalPath, journal.id, 'recovery-required', 'no receiver backup found; nothing changed');
  }
  const agentPresent = await exists(journal.agentDir);
  const rescuePresent = await exists(journal.rescue);
  if (!agentPresent && rescuePresent) {
    const rescueStats = await lstat(journal.rescue);
    if (!identityMatches(journal.agentIdentity, rescueStats)) {
      return advanceAt(journalPath, journal.id, 'recovery-required', 'rescue identity does not match the original tree');
    }
    await rename(journal.rescue, journal.agentDir);
    if ((await digestTree(journal.agentDir)).digest !== journal.agentDigest) {
      return advanceAt(journalPath, journal.id, 'recovery-required', 'restored tree does not match the original digest');
    }
    return advanceAt(journalPath, journal.id, 'recovery-required', 'original restored from the rescue path; backup retained');
  }
  if (agentPresent && rescuePresent) {
    const installed = await digestTree(journal.agentDir).catch(() => undefined);
    const note = installed?.digest === journal.stagedDigest
      ? 'new tree installed and original preserved at the rescue path; backup retained'
      : 'ambiguous on-disk state; nothing changed';
    return advanceAt(journalPath, journal.id, 'recovery-required', note);
  }
  return advanceAt(journalPath, journal.id, 'recovery-required', 'agent directory present; nothing changed');
}

// Restores a verified receiver backup over the agent directory: validate the archive, materialize it in
// a fresh sibling tree and run the same deferred swap, which first backs the current state up again.
// A failure before materialization leaves the destination untouched; a later failure keeps every piece.
export async function restoreReceiverBackup(backupPath: string, agentDir: string, options: SwapRunOptions & Readonly<{ maxExpandedBytes?: number }> = {}): Promise<SwapJournal> {
  const root = checkedPath(agentDir);
  const staging = siblingPath(root, `.restore-${randomUUID()}`);
  const archiveOptions = {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.maxExpandedBytes === undefined ? {} : { maxExpandedBytes: options.maxExpandedBytes }),
  };
  checkAbort(options.signal);
  await previewReceiverBackup(backupPath, archiveOptions);
  await materializeReceiverBackup(backupPath, staging, archiveOptions);
  const plan = await createSwapPlan(root, staging);
  return runSwap(plan, options);
}

export type SwapPreflight = Readonly<{ ok: boolean; reasons: readonly string[]; freeBytes: number;
  requiredBytes: number; marginBytes: number; agentFiles: number; stagedFiles: number;
  agentBytes: number; stagedBytes: number }>;

export type SwapPreflightOptions = SwapRunOptions & Readonly<{ extraBytes?: number; marginBytes?: number }>;

// Read-only preflight: it never writes, installs or moves anything, and reports every reason it found.
// Space is checked with the filesystem counters, so the caller can abort before creating any copy.
export async function preflightSwap(agentDir: string, staging: string, options: SwapPreflightOptions = {}): Promise<SwapPreflight> {
  checkAbort(options.signal);
  const reasons: string[] = [];
  const treeOptions = {
    ...(options.signal ? { signal: options.signal } : {}),
  };
  let agentDigest: TreeDigest | undefined;
  let stagingDigest: TreeDigest | undefined;
  try {
    const stats = await lstat(agentDir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) reasons.push('unsafe-root');
    else agentDigest = await digestTree(agentDir, LITERAL_ARCHIVE_SPEC, treeOptions);
  } catch { reasons.push('unreadable-root'); }
  try {
    const stats = await lstat(staging);
    if (!stats.isDirectory() || stats.isSymbolicLink()) reasons.push('unsafe-staging');
    else stagingDigest = await digestTree(staging, LITERAL_ARCHIVE_SPEC, treeOptions);
  } catch { reasons.push('unreadable-staging'); }
  let freeBytes = -1;
  try {
    const counters = await statfs(dirname(agentDir));
    freeBytes = Number(counters.bavail) * Number(counters.bsize);
  } catch { reasons.push('unavailable-space'); }
  const requiredBytes = (agentDigest?.totalBytes ?? 0) + (options.extraBytes ?? 0);
  const marginBytes = options.marginBytes ?? Math.max(64 * 1024 ** 2, Math.ceil(requiredBytes / 10));
  if (freeBytes >= 0 && freeBytes - requiredBytes < marginBytes) reasons.push('insufficient-space');
  return Object.freeze({
    ok: reasons.length === 0, reasons: Object.freeze(reasons), freeBytes, requiredBytes, marginBytes,
    agentFiles: agentDigest?.files ?? 0, stagedFiles: stagingDigest?.files ?? 0,
    agentBytes: agentDigest?.totalBytes ?? 0, stagedBytes: stagingDigest?.totalBytes ?? 0,
  });
}
