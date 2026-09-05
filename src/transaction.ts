import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBoundedJson, stringifyBounded } from './json.ts';
import { digest, FileStore, StorageError, type FileSnapshot } from './storage.ts';
import { requireDataArray, requireRecord } from './validation.ts';

export interface FileChange { path: string; bytes: Uint8Array; before: FileSnapshot }
interface JournalEntry { path: string; before: string | null; beforeHash: string | null; afterHash: string }
interface Journal {
  format: 'pi-setup-share-journal'; version: 1; id: string;
  state: 'applying' | 'applied' | 'restoring' | 'restored' | 'rolled-back' | 'recovery-required';
  appliedCount: number;
  entries: JournalEntry[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const ownerPath = 'setup-share/owner.json';
const pendingPath = 'setup-share/pending.json';
const pendingLimit = 8192;
const ownerText = '{"format":"pi-setup-share-store","version":1}\n';
const absent: FileSnapshot = { bytes: null, hash: null, signature: null };
const journalLimit = 32 * 1024 * 1024;

export function isImportId(id: string): boolean { return typeof id === 'string' && uuid.test(id); }

function allowed(path: string): boolean {
  if (['settings.json', 'keybindings.json', 'mcp.json'].includes(path)) return true;
  const parts = path.split('/');
  if (parts[0] !== 'setup-share' || parts[1] !== 'imports' || !isImportId(parts[2] ?? '')) return false;
  const rest = parts.slice(3).join('/');
  return ['profile.json', 'manifest.json', 'agents-package/package.json'].includes(rest)
    || /^resources\/(?:extension|skill|prompt|theme)\/.+/.test(rest) || /^agents-package\/agents\/.+/.test(rest);
}

function validatePaths(paths: string[]): void {
  if (paths.length > 272 || paths.some(path => !allowed(path))) throw new StorageError('invalid-state');
  const folded = paths.map(path => path.toLowerCase().toUpperCase().normalize('NFC'));
  const set = new Set(folded);
  if (set.size !== paths.length || folded.some(path => {
    const parts = path.split('/');
    return parts.some((_, index) => index > 0 && set.has(parts.slice(0, index).join('/')));
  })) throw new StorageError('invalid-state');
}

async function managed(store: FileStore): Promise<void> {
  await store.directory('setup-share');
  const owner = await store.read(ownerPath, 1024);
  if (owner.bytes === null) {
    let entries: string[];
    try { entries = await readdir(join(store.root, 'setup-share')); } catch { throw new StorageError('unavailable'); }
    if (entries.length) throw new StorageError('invalid-state');
    await store.write(ownerPath, Buffer.from(ownerText), owner);
  } else if (owner.bytes.toString('utf8') !== ownerText) throw new StorageError('invalid-state');
}

async function lock(store: FileStore): Promise<() => Promise<void>> {
  try { await mkdir(join(store.root, 'setup-share', 'lock'), { mode: 0o700 }); }
  catch (error) { throw new StorageError((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'busy' : 'unavailable'); }
  return async () => {
    try { await rmdir(join(store.root, 'setup-share', 'lock')); }
    catch { throw new StorageError('recovery-required'); }
  };
}

function journalPath(id: string): string {
  if (!isImportId(id)) throw new StorageError('invalid-state');
  return `setup-share/backups/${id}.json`;
}

async function save(store: FileStore, journal: Journal, previous: FileSnapshot): Promise<FileSnapshot> {
  return store.write(journalPath(journal.id), Buffer.from(stringifyBounded(journal, journalLimit)), previous);
}

function decodeJournal(bytes: Buffer | null, id: string): Journal {
  if (!bytes) throw new StorageError('invalid-state');
  const input = parseBoundedJson(bytes.toString('utf8'), journalLimit);
  requireRecord(input, ['format', 'version', 'id', 'state', 'appliedCount', 'entries'], 'journal');
  if (input.format !== 'pi-setup-share-journal' || input.version !== 1 || input.id !== id
      || !['applying', 'applied', 'restoring', 'restored', 'rolled-back', 'recovery-required'].includes(input.state as string)) throw new StorageError('invalid-state');
  requireDataArray(input.entries, 272, 'journal');
  if (typeof input.appliedCount !== 'number' || !Number.isSafeInteger(input.appliedCount) || input.appliedCount < 0 || input.appliedCount > input.entries.length) throw new StorageError('invalid-state');
  let total = 0;
  const entries: JournalEntry[] = input.entries.map(value => {
    requireRecord(value, ['path', 'before', 'beforeHash', 'afterHash'], 'journal');
    if (typeof value.path !== 'string' || typeof value.afterHash !== 'string' || !hash.test(value.afterHash)) throw new StorageError('invalid-state');
    if (value.before === null) {
      if (value.beforeHash !== null) throw new StorageError('invalid-state');
    } else {
      if (typeof value.before !== 'string' || typeof value.beforeHash !== 'string' || !hash.test(value.beforeHash)) throw new StorageError('invalid-state');
      total += Buffer.byteLength(value.before, 'base64');
      if (total > 16 * 1024 * 1024) throw new StorageError('invalid-state');
      const original = Buffer.from(value.before, 'base64');
      if (original.toString('base64') !== value.before || digest(original) !== value.beforeHash) throw new StorageError('invalid-state');
    }
    return { path: value.path, before: value.before as string | null, beforeHash: value.beforeHash as string | null, afterHash: value.afterHash };
  });
  validatePaths(entries.map(entry => entry.path));
  return { format: 'pi-setup-share-journal', version: 1, id, state: input.state as Journal['state'], appliedCount: input.appliedCount, entries };
}

async function undo(store: FileStore, journal: Journal, partial: boolean): Promise<void> {
  const work: { entry: JournalEntry; current: FileSnapshot }[] = [];
  // Preflight every destination before touching any of them.
  for (const entry of journal.entries) {
    const current = await store.read(entry.path, journalLimit);
    if (partial && current.hash === entry.beforeHash) continue;
    if (current.hash !== entry.afterHash) throw new StorageError('changed');
    work.push({ entry, current });
  }
  for (const { entry, current } of work.reverse()) {
    if (entry.before === null) await store.remove(entry.path, current);
    else await store.write(entry.path, Buffer.from(entry.before, 'base64'), current);
  }
}

function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new StorageError('aborted'); }

export async function commitChanges(store: FileStore, changes: readonly FileChange[], consent: boolean, signal?: AbortSignal, transactionId = randomUUID()): Promise<string | null> {
  if (consent !== true) throw new StorageError('consent-required');
  abort(signal);
  journalPath(transactionId);
  validatePaths(changes.map(change => change.path));
  let total = 0;
  let afterTotal = 0;
  const selected = changes.map(change => {
    total += change.before.bytes?.byteLength ?? 0;
    afterTotal += change.bytes.byteLength;
    if (total > 16 * 1024 * 1024 || afterTotal > journalLimit) throw new StorageError('limit-exceeded');
    const before = change.before;
    if (before.bytes === null ? before.hash !== null || before.signature !== null
      : !Buffer.isBuffer(before.bytes) || digest(before.bytes) !== before.hash || typeof before.signature !== 'string') throw new StorageError('invalid-state');
    return { ...change, bytes: Buffer.from(change.bytes), before: { ...before, bytes: before.bytes === null ? null : Buffer.from(before.bytes) } };
  });
  await managed(store);
  const release = await lock(store);
  try {
    if ((await store.read(pendingPath, pendingLimit)).bytes !== null) throw new StorageError('recovery-required');
    for (const change of selected) if (!await store.matches(change.path, change.before)) throw new StorageError('changed');
    const effective = selected.filter(change => digest(change.bytes) !== change.before.hash);
    if (!effective.length) return null;
    const journal: Journal = { format: 'pi-setup-share-journal', version: 1, id: transactionId, state: 'applying', appliedCount: 0, entries: effective.map(change => ({ path: change.path, before: change.before.bytes?.toString('base64') ?? null, beforeHash: change.before.hash, afterHash: digest(change.bytes) })) };
    let journalState = await save(store, journal, absent);
    const pending = await store.write(pendingPath, Buffer.from(stringifyBounded({ ids: [journal.id], cursor: 0 }, pendingLimit)), absent);
    try {
      for (let index = 0; index < effective.length; index++) {
        abort(signal);
        const change = effective[index] as FileChange;
        await store.write(change.path, change.bytes, change.before);
        journal.appliedCount = index + 1;
        journalState = await save(store, journal, journalState);
      }
      journal.state = 'applied';
      journalState = await save(store, journal, journalState);
      await store.remove(pendingPath, pending);
      return journal.id;
    } catch (error) {
      try {
        await undo(store, journal, true);
        journal.state = 'rolled-back';
        journalState = await save(store, journal, await store.read(journalPath(journal.id), journalLimit));
        await store.remove(pendingPath, pending);
      } catch {
        journal.state = 'recovery-required';
        try { await save(store, journal, await store.read(journalPath(journal.id), journalLimit)); } catch { /* The pending pointer remains the recovery gate. */ }
        throw new StorageError('recovery-required');
      }
      if (error instanceof StorageError) throw error;
      throw new StorageError('unavailable');
    }
  } finally { await release(); }
}

export async function restoreChanges(store: FileStore, id: string, consent: boolean): Promise<void> {
  return restoreChain(store, [id], consent);
}

export async function restoreChain(store: FileStore, newestFirst: readonly string[], consent: boolean): Promise<void> {
  if (consent !== true) throw new StorageError('consent-required');
  requireDataArray(newestFirst, 128, 'restore');
  if (new Set(newestFirst).size !== newestFirst.length || newestFirst.some(id => !isImportId(id))) throw new StorageError('invalid-state');
  await managed(store);
  const release = await lock(store);
  try {
    if ((await store.read(pendingPath, pendingLimit)).bytes !== null) throw new StorageError('recovery-required');
    const chain: { journal: Journal; snapshot: FileSnapshot }[] = [];
    const virtual = new Map<string, string | null>();
    let totalBytes = 0;
    // Simulate the entire reverse chain before changing any destination or journal.
    for (const id of newestFirst) {
      const snapshot = await store.read(journalPath(id), journalLimit);
      totalBytes += snapshot.bytes?.byteLength ?? 0;
      if (totalBytes > journalLimit) throw new StorageError('limit-exceeded');
      const journal = decodeJournal(snapshot.bytes, id);
      if (journal.state !== 'applied') throw new StorageError('invalid-state');
      for (const entry of journal.entries) {
        const currentHash = virtual.has(entry.path) ? virtual.get(entry.path) : (await store.read(entry.path, journalLimit)).hash;
        if (currentHash !== entry.afterHash) throw new StorageError('changed');
        virtual.set(entry.path, entry.beforeHash);
      }
      chain.push({ journal, snapshot });
    }
    if (!chain.length) return;
    let pending = await store.write(pendingPath, Buffer.from(stringifyBounded({ ids: [...newestFirst], cursor: 0 }, pendingLimit)), absent);
    for (let index = 0; index < chain.length; index++) {
      const step = chain[index] as { journal: Journal; snapshot: FileSnapshot };
      const { journal } = step;
      try {
        journal.state = 'restoring';
        step.snapshot = await save(store, journal, step.snapshot);
        await undo(store, journal, false);
        journal.state = 'restored';
        await save(store, journal, step.snapshot);
        pending = await store.write(pendingPath, Buffer.from(stringifyBounded({ ids: [...newestFirst], cursor: index + 1 }, pendingLimit)), pending);
      } catch {
        if (journal.state !== 'restored') {
          journal.state = 'recovery-required';
          try { await save(store, journal, await store.read(journalPath(journal.id), journalLimit)); } catch { /* The chain pointer remains the recovery gate. */ }
        }
        throw new StorageError('recovery-required');
      }
    }
    await store.remove(pendingPath, pending);
  } finally { await release(); }
}

export async function recoverChanges(store: FileStore, consent: boolean, breakStaleLock = false): Promise<void> {
  if (consent !== true) throw new StorageError('consent-required');
  await managed(store);
  if (breakStaleLock === true) {
    // The caller must separately confirm that no other import is running. Never automatic.
    try { await rmdir(join(store.root, 'setup-share', 'lock')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new StorageError('busy'); }
  }
  const release = await lock(store);
  try {
    let pending = await store.read(pendingPath, pendingLimit);
    if (!pending.bytes) return;
    const pointer = parseBoundedJson(pending.bytes.toString('utf8'), pendingLimit);
    requireRecord(pointer, ['ids', 'cursor'], 'recovery');
    requireDataArray(pointer.ids, 128, 'recovery');
    if (pointer.ids.some(id => typeof id !== 'string' || !isImportId(id)) || new Set(pointer.ids).size !== pointer.ids.length
        || typeof pointer.cursor !== 'number' || !Number.isSafeInteger(pointer.cursor) || pointer.cursor < 0 || pointer.cursor > pointer.ids.length) throw new StorageError('invalid-state');
    const ids = pointer.ids as string[];
    const remaining: { journal: Journal; snapshot: FileSnapshot }[] = [];
    const virtual = new Map<string, string | null>();
    let totalBytes = 0;
    for (const id of ids.slice(pointer.cursor)) {
      const snapshot = await store.read(journalPath(id), journalLimit);
      totalBytes += snapshot.bytes?.byteLength ?? 0;
      if (totalBytes > journalLimit) throw new StorageError('limit-exceeded');
      const journal = decodeJournal(snapshot.bytes, id);
      for (const entry of journal.entries) {
        const currentHash = virtual.has(entry.path) ? virtual.get(entry.path) : (await store.read(entry.path, journalLimit)).hash;
        if (currentHash !== entry.beforeHash && currentHash !== entry.afterHash) throw new StorageError('changed');
        virtual.set(entry.path, entry.beforeHash);
      }
      remaining.push({ journal, snapshot });
    }
    for (let index = 0; index < remaining.length; index++) {
      const { journal, snapshot } = remaining[index] as { journal: Journal; snapshot: FileSnapshot };
      await undo(store, journal, true);
      journal.state = 'rolled-back';
      await save(store, journal, snapshot);
      pending = await store.write(pendingPath, Buffer.from(stringifyBounded({ ids, cursor: pointer.cursor + index + 1 }, pendingLimit)), pending);
    }
    await store.remove(pendingPath, pending);
  } finally { await release(); }
}
