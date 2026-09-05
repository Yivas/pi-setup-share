import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { serializeProfile } from './export.ts';
import { parseProfile, PROFILE_LIMITS, type ResourceProfile } from './profile.ts';
import { digest, FileStore, StorageError } from './storage.ts';

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StorageError('aborted');
}

function checkPath(path: string): void {
  const excluded = new Set(['auth.json', 'trust.json', 'settings.json', 'keybindings.json', 'models.json', 'mcp.json', 'sessions', 'history', 'logs', 'node_modules']);
  if (typeof path !== 'string' || !isAbsolute(path) || Buffer.byteLength(path) > 4096
      || /^[\\/]{2}/.test(path) || /[\p{C}]/u.test(path)
      || path.split(/[\\/]/).some(part => excluded.has(part.toLowerCase()) || part.toLowerCase().startsWith('.env'))) {
    throw new StorageError('unsafe-path');
  }
}

export async function readProfileFile(path: string, signal?: AbortSignal): Promise<ResourceProfile> {
  checkAbort(signal);
  checkPath(path);
  const store = await FileStore.open(dirname(path));
  const snapshot = await store.read(basename(path), PROFILE_LIMITS.jsonBytes);
  checkAbort(signal);
  if (!snapshot.bytes) throw new StorageError('unavailable');
  if (!isUtf8(snapshot.bytes)) throw new StorageError('invalid-state');
  return parseProfile(snapshot.bytes.toString('utf8'));
}

export async function writeProfileFile(path: string, profile: unknown, consent: boolean, signal?: AbortSignal): Promise<void> {
  if (consent !== true) throw new StorageError('consent-required');
  checkAbort(signal);
  checkPath(path);
  const bytes = Buffer.from(serializeProfile(profile));
  const store = await FileStore.open(dirname(path));
  const name = basename(path);
  // Validate the filename and parent without reading an existing destination's contents.
  try {
    if ((await store.read(name, 0)).bytes !== null) throw new StorageError('changed');
  } catch (error) {
    if (error instanceof StorageError && error.code === 'limit-exceeded') throw new StorageError('changed');
    throw error;
  }
  checkAbort(signal);
  try {
    const handle = await open(join(store.root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    // An interrupted write may leave an incomplete file. Never reuse or delete that path automatically.
    try { checkAbort(signal); await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    if ((await store.read(name, PROFILE_LIMITS.jsonBytes)).hash !== digest(bytes)) throw new StorageError('changed');
    checkAbort(signal);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new StorageError('changed');
    throw new StorageError('unavailable');
  }
}
