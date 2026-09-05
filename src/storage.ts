import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

export type StorageErrorCode = 'unavailable' | 'unsafe-path' | 'changed' | 'limit-exceeded' | 'busy' | 'invalid-state' | 'recovery-required' | 'consent-required' | 'aborted';
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode) {
    super(code);
    this.name = 'StorageError';
    this.code = code;
  }
}

export interface FileSnapshot {
  bytes: Buffer | null;
  hash: string | null;
  signature: string | null;
}

export function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

function signature(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.nlink].join(':');
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function safeError(error: unknown): never {
  if (error instanceof StorageError) throw error;
  throw new StorageError('unavailable');
}

function segments(path: string): string[] {
  if (typeof path !== 'string' || Buffer.byteLength(path) > 512 || path !== path.normalize('NFC') || /[\p{C}<>:"\\|?*]/u.test(path)) throw new StorageError('unsafe-path');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /^[ .]|[ .]$/.test(part)
      || Buffer.byteLength(part) > 100 || /^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new StorageError('unsafe-path');
  return parts;
}

export class FileStore {
  readonly root: string;
  private readonly identity: BigIntStats;
  private constructor(root: string, identity: BigIntStats) { this.root = root; this.identity = identity; }

  static async open(root: string): Promise<FileStore> {
    try {
      if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw new StorageError('unsafe-path');
      const initial = await lstat(root, { bigint: true });
      if (!initial.isDirectory() || initial.isSymbolicLink()) throw new StorageError('unsafe-path');
      const canonical = await realpath(root);
      const stat = await lstat(canonical, { bigint: true });
      if (initial.dev !== stat.dev || initial.ino !== stat.ino) throw new StorageError('changed');
      return new FileStore(canonical, stat);
    } catch (error) { return safeError(error); }
  }

  private async checkRoot(): Promise<void> {
    const current = await lstat(this.root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== this.identity.dev || current.ino !== this.identity.ino) throw new StorageError('changed');
  }

  private async inspect(path: string): Promise<BigIntStats | null> {
    const parts = segments(path);
    await this.checkRoot();
    let current = this.root;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index] as string);
      let stat: BigIntStats;
      try { stat = await lstat(current, { bigint: true }); }
      catch (error) { if (missing(error)) return null; throw error; }
      if (stat.isSymbolicLink()) throw new StorageError('unsafe-path');
      if (index < parts.length - 1) {
        if (!stat.isDirectory()) throw new StorageError('unsafe-path');
      } else {
        if (!stat.isFile() || stat.nlink !== 1n) throw new StorageError('unsafe-path');
        return stat;
      }
    }
    throw new StorageError('unsafe-path');
  }

  async read(path: string, limit = 4 * 1024 * 1024): Promise<FileSnapshot> {
    try {
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > 32 * 1024 * 1024) throw new StorageError('limit-exceeded');
      const before = await this.inspect(path);
      if (!before) return { bytes: null, hash: null, signature: null };
      if (before.size < 0n || before.size > BigInt(limit)) throw new StorageError('limit-exceeded');
      const handle = await open(join(this.root, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        if (signature(await handle.stat({ bigint: true })) !== signature(before)) throw new StorageError('changed');
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        const current = await this.inspect(path);
        if (!current || signature(before) !== signature(after) || signature(before) !== signature(current) || BigInt(length) !== before.size) throw new StorageError('changed');
        const bytes = buffer.subarray(0, length);
        return { bytes, hash: digest(bytes), signature: signature(after) };
      } finally { await handle.close(); }
    } catch (error) { return safeError(error); }
  }

  async matches(path: string, expected: FileSnapshot): Promise<boolean> {
    const actual = await this.read(path, 32 * 1024 * 1024);
    return actual.hash === expected.hash && actual.signature === expected.signature;
  }

  async directory(path: string): Promise<void> {
    try {
      const parts = segments(path);
      await this.checkRoot();
      let current = this.root;
      for (const part of parts) {
        current = join(current, part);
        let stat: BigIntStats;
        try { stat = await lstat(current, { bigint: true }); }
        catch (error) {
          if (!missing(error)) throw error;
          await mkdir(current, { mode: 0o700 });
          stat = await lstat(current, { bigint: true });
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageError('unsafe-path');
      }
    } catch (error) { return safeError(error); }
  }

  async write(path: string, bytes: Uint8Array, expected: FileSnapshot): Promise<FileSnapshot> {
    let temporary: string | undefined;
    try {
      segments(path);
      if (bytes.byteLength > 32 * 1024 * 1024) throw new StorageError('limit-exceeded');
      const content = Buffer.from(bytes);
      if (!await this.matches(path, expected)) throw new StorageError('changed');
      const parent = dirname(path).replaceAll('\\', '/');
      if (parent !== '.') await this.directory(parent);
      temporary = join(this.root, parent, `tmp-${randomUUID()}`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await handle.writeFile(content); await handle.sync(); }
      finally { await handle.close(); }
      if (!await this.matches(path, expected)) throw new StorageError('changed');
      await rename(temporary, join(this.root, path));
      temporary = undefined;
      const result = await this.read(path, 32 * 1024 * 1024);
      if (result.hash !== digest(content)) throw new StorageError('changed');
      return result;
    } catch (error) { return safeError(error); }
    finally {
      if (temporary) {
        try { await unlink(temporary); } catch (error) { if (!missing(error)) safeError(error); }
      }
    }
  }

  async remove(path: string, expected: FileSnapshot): Promise<void> {
    try {
      if (!await this.matches(path, expected)) throw new StorageError('changed');
      if (expected.bytes !== null) await unlink(join(this.root, path));
    } catch (error) { return safeError(error); }
  }
}
