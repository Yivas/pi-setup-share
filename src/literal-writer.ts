// Literal archive writer: copies a synthetic tree into the versioned ZIP format that
// `previewLiteralArchive` reads back. It stays unwired from the TUI and refuses to publish until the
// written archive has been re-read and verified.
//
// Known limits, recorded in planning/02.modos-de-copia: this module works with path-based Node APIs,
// so an adversary that replaces an ancestor directory during the walk is not fully excluded (the
// native handle-relative reader exists but is not wired yet), Windows private DACLs are not verified
// and the temporary file could still be swapped between verification and publication; both are
// bounded by re-reading the temporary and comparing identities before and after publishing.
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { constants, createWriteStream, type Stats } from 'node:fs';
import { link, lstat, open, opendir, readlink, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yazl from 'yazl';
import { previewTreeArchive } from './literal-archive.ts';
import { LITERAL_ARCHIVE_SPEC, LITERAL_MANIFEST_LIMITS, type LiteralEntry, type LiteralManifest, type TreeArchiveSpec } from './literal-manifest.ts';
import { StorageError } from './storage.ts';

export type LiteralWriterOptions = Readonly<{ signal?: AbortSignal; maxTotalBytes?: number }>;
export type LiteralWriterResult = Readonly<{ files: number; directories: number; symlinks: number; totalBytes: number }>;

type LiteralFileSource = Readonly<{
  path: string; full: string; size: number; sha256: string;
  dev: number; ino: number; mtimeMs: number; ctimeMs: number;
}>;

const ZIP_TIME = new Date('1980-01-01T00:00:00.000Z');

function invalid(): never { throw new StorageError('invalid-state'); }
function unsafe(): never { throw new StorageError('unsafe-path'); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new StorageError('aborted'); }

function sameFile(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameSource(source: LiteralFileSource, stats: Stats): boolean {
  return stats.isFile() && stats.dev === source.dev && stats.ino === source.ino && stats.size === source.size
    && stats.mtimeMs === source.mtimeMs && stats.ctimeMs === source.ctimeMs;
}

async function normalizeRoot(root: string): Promise<string> {
  const stats = await lstat(root).catch(() => invalid());
  if (!stats.isDirectory() || stats.isSymbolicLink()) unsafe();
  // Use the resolved path for comparisons, but do not require it to equal the argument: on macOS the
  // system temp directory lives behind /var -> /private/var and that is still a legitimate root.
  const resolved = await realpath(root);
  const resolvedStats = await lstat(resolved).catch(() => invalid());
  if (!resolvedStats.isDirectory() || resolvedStats.isSymbolicLink()) unsafe();
  return resolved;
}

// Hashes one regular file while checking that the opened handle and the path still describe it.
async function fingerprint(path: string, initial: Stats, limit: number, signal?: AbortSignal): Promise<{ sha256: string; size: number }> {
  const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = await file.stat();
    if (!sameFile(initial, opened)) invalid();
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      checkAbort(signal);
      size += chunk.length;
      if (size > opened.size || size > limit) throw new StorageError('limit-exceeded');
      hash.update(chunk);
    }
    const after = await file.stat();
    const pathAfter = await lstat(path);
    if (!sameFile(opened, after) || !sameFile(opened, pathAfter) || size !== opened.size) invalid();
    return { sha256: hash.digest('hex'), size };
  } finally {
    await file.close();
  }
}

// Walks the root without following links; hardlinked paths are stored as independent bytes.
async function inventory(root: string, spec: TreeArchiveSpec, maxTotalBytes: number, signal?: AbortSignal): Promise<{ manifest: LiteralManifest; sources: readonly LiteralFileSource[] }> {
  checkAbort(signal);
  const before = await lstat(root);
  if (!before.isDirectory() || before.isSymbolicLink()) unsafe();
  const entries: LiteralEntry[] = [];
  const sources: LiteralFileSource[] = [];
  let total = 0;
  async function visit(directory: string, prefix: string, depth: number): Promise<void> {
    checkAbort(signal);
    if (depth > LITERAL_MANIFEST_LIMITS.depth) throw new StorageError('limit-exceeded');
    const openedBefore = await lstat(directory);
    if (!openedBefore.isDirectory() || openedBefore.isSymbolicLink()) unsafe();
    const stream = await opendir(directory);
    for await (const child of stream) {
      checkAbort(signal);
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (Buffer.byteLength(path, 'utf8') > LITERAL_MANIFEST_LIMITS.pathBytes
          || entries.length >= spec.maxEntries) throw new StorageError('limit-exceeded');
      const full = join(directory, child.name);
      const stats = await lstat(full);
      if (stats.isSymbolicLink()) {
        const target = await readlink(full);
        const after = await lstat(full);
        if (stats.dev !== after.dev || stats.ino !== after.ino || stats.mtimeMs !== after.mtimeMs
            || stats.ctimeMs !== after.ctimeMs || target !== await readlink(full)) invalid();
        entries.push({ path, type: 'symlink', target });
      } else if (stats.isDirectory()) {
        entries.push({ path, type: 'directory', mode: stats.mode & 0o777 });
        await visit(full, path, depth + 1);
      } else if (stats.isFile()) {
        const { sha256, size } = await fingerprint(full, stats, spec.totalBytesLimit, signal);
        total += size;
        if (total > maxTotalBytes) throw new StorageError('limit-exceeded');
        entries.push({ path, type: 'file', mode: stats.mode & 0o777, size, sha256 });
        sources.push({ path, full, size, sha256, dev: stats.dev, ino: stats.ino, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs });
      } else unsafe();
    }
    const openedAfter = await lstat(directory);
    if (!openedAfter.isDirectory() || openedBefore.dev !== openedAfter.dev || openedBefore.ino !== openedAfter.ino
        || openedBefore.mtimeMs !== openedAfter.mtimeMs || openedBefore.ctimeMs !== openedAfter.ctimeMs) invalid();
  }
  await visit(root, '', 0);
  const after = await lstat(root);
  if (before.dev !== after.dev || before.ino !== after.ino
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) invalid();
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  let manifest: LiteralManifest;
  try {
    manifest = spec.validateManifest({ format: spec.format, version: 1,
      root: 'agentDir', sourcePlatform: process.platform, totalBytes: total, entries });
  } catch (error) {
    // The manifest validator reports path-safety failures as StorageError('unsafe-path'); keep them.
    if (error instanceof StorageError) throw error;
    invalid();
  }
  const byPath = new Map(sources.map(source => [source.path, source]));
  const ordered = manifest.entries.filter(item => item.type === 'file').map(item => byPath.get(item.path) as LiteralFileSource);
  return { manifest, sources: Object.freeze(ordered) };
}

// Streams one source while rechecking the recorded identity before and after every read.
async function verifiedStream(source: LiteralFileSource, signal?: AbortSignal): Promise<Transform> {
  checkAbort(signal);
  const file = await open(source.full, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    if (!sameSource(source, await file.stat()) || !sameSource(source, await lstat(source.full))) invalid();
    let size = 0;
    const hash = createHash('sha256');
    const stream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > source.size) { callback(new StorageError('invalid-state')); return; }
        hash.update(chunk);
        callback(null, chunk);
      },
      flush(callback) {
        void (async () => {
          checkAbort(signal);
          if (size !== source.size || hash.digest('hex') !== source.sha256
              || !sameSource(source, await file.stat()) || !sameSource(source, await lstat(source.full))) invalid();
          callback();
        })().catch(error => callback(error as Error));
      },
    });
    const input = file.createReadStream({ autoClose: false });
    input.on('error', error => stream.destroy(error));
    stream.once('close', () => { input.destroy(); void file.close(); });
    input.pipe(stream);
    return stream;
  } catch (error) {
    await file.close();
    throw error;
  }
}

// The archive is only published after it has been read back and verified; an existing destination is
// never replaced, and a failed attempt leaves no temporary file behind.
export async function writeTreeArchive(root: string, destination: string, spec: TreeArchiveSpec, options: LiteralWriterOptions = {}): Promise<LiteralWriterResult> {
  checkAbort(options.signal);
  const maxTotalBytes = options.maxTotalBytes ?? spec.totalBytesLimit;
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0) throw new StorageError('limit-exceeded');
  const rootPath = await normalizeRoot(root);
  const parent = await realpath(dirname(destination)).catch(() => invalid());
  const inside = relative(rootPath, parent);
  if (inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))) unsafe();
  if (await lstat(destination).then(() => true, () => false)) unsafe();
  const inventoryBefore = await inventory(rootPath, spec, maxTotalBytes, options.signal);
  const manifestBytes = Buffer.from(JSON.stringify(inventoryBefore.manifest), 'utf8');
  if (manifestBytes.length > spec.manifestBytes) throw new StorageError('limit-exceeded');
  const temporary = join(parent, `.${basename(destination)}.${randomBytes(12).toString('hex')}.tmp`);
  const zip = new yazl.ZipFile();
  zip.addBuffer(manifestBytes, spec.manifestName, { mtime: ZIP_TIME, mode: 0o100600, compress: true, forceDosTimestamp: true });
  inventoryBefore.sources.forEach((source, index) => {
    zip.addReadStreamLazy(`${spec.payloadPrefix}${String(index + 1).padStart(6, '0')}`,
      { mtime: ZIP_TIME, mode: 0o100600, compress: true, forceDosTimestamp: true, size: source.size },
      callback => { void verifiedStream(source, options.signal).then(stream => callback(null, stream), error => callback(error, undefined as never)); });
  });
  zip.end({ comment: '', forceZip64Format: false });
  let publishedIdentity: Stats | undefined;
  try {
    checkAbort(options.signal);
    await pipeline(zip.outputStream, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: options.signal });
    const handle = await open(temporary, 'r+');
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > spec.archiveBytes) throw new StorageError('limit-exceeded');
      await handle.sync();
      publishedIdentity = stats;
    } finally { await handle.close(); }
    checkAbort(options.signal);
    const inventoryAfter = await inventory(rootPath, spec, maxTotalBytes, options.signal);
    if (JSON.stringify(inventoryAfter.manifest) !== JSON.stringify(inventoryBefore.manifest)
        || JSON.stringify(inventoryAfter.sources) !== JSON.stringify(inventoryBefore.sources)) invalid();
    checkAbort(options.signal);
    const previewOptions = options.signal
      ? { signal: options.signal, maxExpandedBytes: maxTotalBytes }
      : { maxExpandedBytes: maxTotalBytes };
    await previewTreeArchive(temporary, spec, previewOptions);
    checkAbort(options.signal);
    const verified = await lstat(temporary);
    if (!verified.isFile() || verified.dev !== publishedIdentity.dev || verified.ino !== publishedIdentity.ino
        || verified.size !== publishedIdentity.size) invalid();
    await link(temporary, destination);
    const published = await lstat(destination);
    if (!published.isFile() || published.dev !== verified.dev || published.ino !== verified.ino || published.size !== verified.size) invalid();
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if ((error as NodeJS.ErrnoException)?.name === 'AbortError') throw new StorageError('aborted');
    throw new StorageError('invalid-state');
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const manifest = inventoryBefore.manifest;
  return Object.freeze({ files: inventoryBefore.sources.length,
    directories: manifest.entries.filter(item => item.type === 'directory').length,
    symlinks: manifest.entries.filter(item => item.type === 'symlink').length,
    totalBytes: manifest.totalBytes });
}

export async function writeLiteralArchive(root: string, destination: string, options: LiteralWriterOptions = {}): Promise<LiteralWriterResult> {
  return writeTreeArchive(root, destination, LITERAL_ARCHIVE_SPEC, options);
}
