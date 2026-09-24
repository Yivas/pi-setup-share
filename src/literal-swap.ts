// Deferred-swap journal and plan for the literal mode. The journal lives outside the directory being
// replaced, stores identities and protected paths but never secret bytes, and is written atomically so
// an interrupted transition can be recognized instead of guessed. Nothing here swaps anything yet: the
// post-exit auxiliary state machine builds on this contract.
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { type Stats } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
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
  createdAt: string;
  updatedAt: string;
  note?: string;
}>;

const JOURNAL_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;

function invalid(): never { throw new StorageError('invalid-state'); }
function unsafe(): never { throw new StorageError('unsafe-path'); }

function checkedPath(value: unknown): string {
  if (typeof value !== 'string' || !value || !isAbsolute(value) || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
      || /[\p{C}]/u.test(value) || value !== value.normalize('NFC')) unsafe();
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

// The journal is data, so it is validated as strictly as any other persisted contract.
export function validateSwapJournal(value: unknown): SwapJournal {
  if (value === null || typeof value !== 'object') invalid();
  const candidate = value as Record<string, unknown>;
  if (candidate.format !== SWAP_FORMAT || candidate.version !== 1) invalid();
  if (typeof candidate.id !== 'string' || !/^[0-9a-f-]{36}$/.test(candidate.id)) invalid();
  if (typeof candidate.state !== 'string' || !(SWAP_STATES as readonly string[]).includes(candidate.state)) invalid();
  const agentDir = checkedPath(candidate.agentDir);
  const staging = checkedPath(candidate.staging);
  const rescue = checkedPath(candidate.rescue);
  const backup = checkedPath(candidate.backup);
  if (new Set([agentDir, staging, rescue, backup]).size !== 4) invalid();
  // Rescue, backup and journal are siblings of the root being replaced, never inside it.
  for (const path of [rescue, backup]) {
    if (path.startsWith(`${agentDir}/`) || path.startsWith(`${agentDir}\\`)) unsafe();
  }
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
  const now = new Date().toISOString();
  const journal: SwapJournal = Object.freeze({
    format: SWAP_FORMAT, version: 1, id, state: 'staged',
    agentDir: root, staging: staged, rescue, backup,
    agentIdentity: captureIdentity(rootStats), stagingIdentity: captureIdentity(stagingStats),
    createdAt: now, updatedAt: now,
  });
  await writeSwapJournal(journalPath, journal);
  return Object.freeze({ journalPath, journal, agentIdentity: journal.agentIdentity, stagingIdentity: journal.stagingIdentity });
}

// Re-reads the journal and the filesystem before any transition; a mismatch is never guessed away.
export async function advanceSwapJournal(plan: SwapPlan, state: SwapState, note?: string): Promise<SwapJournal> {
  const bytes = await readFile(plan.journalPath).catch(() => invalid());
  const current = validateSwapJournal(JSON.parse(bytes.toString('utf8')));
  if (current.id !== plan.journal.id) invalid();
  const next: SwapJournal = Object.freeze({
    ...current, state, updatedAt: new Date().toISOString(),
    ...(note === undefined ? {} : { note }),
  });
  await writeSwapJournal(plan.journalPath, next);
  return next;
}
