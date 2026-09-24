import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, symlink, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import * as yauzl from 'yauzl';
import { LITERAL_ARCHIVE_SPEC, type LiteralManifest, type TreeArchiveSpec } from './literal-manifest.ts';
import { StorageError } from './storage.ts';

const ALLOWED_FLAGS = 0x0008 | 0x0800;

export type LiteralPreviewOptions = Readonly<{ signal?: AbortSignal; maxExpandedBytes?: number }>;

// Verification seam for the materializer: called with the completed temporary once it has been proven to be
// the directory this call created and before it is published, so negative tests can substitute it there.
export type LiteralMaterializeOptions = LiteralPreviewOptions & { onStaged?: (temporary: string) => void | Promise<void> };

// Record of what this call created: the directory, the ownership token beside it, and the token value.
type MaterializedOwner = Readonly<{ directory: Stats; token: Stats; value: string }>;

// The second pass materializes a verified tree; the first pass only reports counts.
type TreeVisitor = Readonly<{
  directory(path: string, mode: number): Promise<void>;
  symlink(path: string, target: string): Promise<void>;
  file(path: string, mode: number): Promise<{ write(chunk: Buffer): Promise<void>; close(): Promise<void> }>;
}>;

export type LiteralPreview = Readonly<{
  sourcePlatform: LiteralManifest['sourcePlatform'];
  files: number;
  directories: number;
  symlinks: number;
  totalBytes: number;
}>;

function invalid(): never { throw new StorageError('invalid-state'); }
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StorageError('aborted');
}

async function bytesAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) invalid();
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await file.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) invalid();
    offset += result.bytesRead;
  }
  return buffer;
}

function uint64(bytes: Buffer, offset: number): number {
  const number = bytes.readBigUInt64LE(offset);
  if (number > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return Number(number);
}

// Require a single contiguous central directory and an EOCD exactly at EOF.
async function layout(file: FileHandle, fileSize: number, spec: TreeArchiveSpec): Promise<{ offset: number; end: number; count: number }> {
  if (fileSize < 22 || fileSize > spec.archiveBytes) throw new StorageError('limit-exceeded');
  const end = await bytesAt(file, fileSize - 22, 22);
  if (end.readUInt32LE(0) !== 0x06054b50 || end.readUInt16LE(4) !== 0 || end.readUInt16LE(6) !== 0
      || end.readUInt16LE(8) !== end.readUInt16LE(10) || end.readUInt16LE(20) !== 0) invalid();
  let count = end.readUInt16LE(10);
  let size = end.readUInt32LE(12);
  let offset = end.readUInt32LE(16);
  let directoryEnd = fileSize - 22;
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locatorAt = directoryEnd - 20;
    if (locatorAt < 56) invalid();
    const locator = await bytesAt(file, locatorAt, 20);
    if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0
        || locator.readUInt32LE(16) !== 1) invalid();
    directoryEnd = uint64(locator, 8);
    if (directoryEnd + 56 !== locatorAt) invalid();
    const zip64 = await bytesAt(file, directoryEnd, 56);
    if (zip64.readUInt32LE(0) !== 0x06064b50 || uint64(zip64, 4) !== 44
        || zip64.readUInt32LE(16) !== 0 || zip64.readUInt32LE(20) !== 0
        || uint64(zip64, 24) !== uint64(zip64, 32)) invalid();
    count = uint64(zip64, 32);
    size = uint64(zip64, 40);
    offset = uint64(zip64, 48);
  }
  if (count < 1 || count > spec.maxEntries + 1 || offset + size !== directoryEnd
      || size < count * 46 || size > 256 * 1024 ** 2) invalid();
  return { offset, end: directoryEnd, count };
}

async function descriptorSize(file: FileHandle, entry: yauzl.Entry, start: number,
  centralOffset: number, zip64Local: boolean): Promise<number> {
  if ((entry.generalPurposeBitFlag & 0x0008) === 0) return 0;
  const large = zip64Local || entry.compressedSize > 0xffffffff || entry.uncompressedSize > 0xffffffff;
  const width = large ? 8 : 4;
  for (const signature of [true, false]) {
    const size = (signature ? 4 : 0) + 4 + width * 2;
    if (start + size > centralOffset) continue;
    const bytes = await bytesAt(file, start, size);
    let cursor = 0;
    if (signature) {
      if (bytes.readUInt32LE(cursor) !== 0x08074b50) continue;
      cursor += 4;
    }
    if (bytes.readUInt32LE(cursor) !== entry.crc32) continue;
    cursor += 4;
    const compressed = width === 8 ? uint64(bytes, cursor) : bytes.readUInt32LE(cursor);
    cursor += width;
    const uncompressed = width === 8 ? uint64(bytes, cursor) : bytes.readUInt32LE(cursor);
    if (compressed === entry.compressedSize && uncompressed === entry.uncompressedSize) return size;
  }
  invalid();
}

async function digestEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, limit: number,
  expectedSha?: string, signal?: AbortSignal, sink?: (chunk: Buffer) => Promise<void>): Promise<Buffer | undefined> {
  checkAbort(signal);
  const stream = await zip.openReadStreamPromise(entry);
  const hash = createHash('sha256');
  let crc = 0;
  let total = 0;
  const chunks: Buffer[] | undefined = expectedSha ? undefined : [];
  const abort = () => stream.destroy(new StorageError('aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const piece of stream) {
      checkAbort(signal);
      const bytes = Buffer.from(piece);
      total += bytes.length;
      if (total > limit || total > entry.uncompressedSize) throw new StorageError('limit-exceeded');
      hash.update(bytes);
      crc = crc32(bytes, crc);
      if (sink) await sink(bytes);
      chunks?.push(bytes);
    }
  } catch (error) {
    stream.destroy();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  checkAbort(signal);
  if (total !== entry.uncompressedSize || (crc >>> 0) !== entry.crc32
      || (expectedSha && hash.digest('hex') !== expectedSha)) invalid();
  return chunks && Buffer.concat(chunks, total);
}

function extras(bytes: Buffer): Map<number, Buffer> {
  const fields = new Map<number, Buffer>();
  let cursor = 0;
  while (cursor < bytes.length) {
    if (cursor + 4 > bytes.length) invalid();
    const id = bytes.readUInt16LE(cursor);
    const length = bytes.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + length > bytes.length || fields.has(id) || id !== 0x0001) invalid();
    const data = bytes.subarray(cursor, cursor + length);
    fields.set(id, data);
    cursor += length;
  }
  return fields;
}

function entryName(entry: yauzl.Entry, expected: string, maxBytes: number): Map<number, Buffer> {
  if (entry.fileName !== expected || !entry.fileNameRaw.equals(Buffer.from(expected, 'utf8'))
      || entry.fileNameLength > maxBytes || entry.fileCommentLength !== 0
      || entry.isEncrypted() || !entry.canDecodeFileData()
      || (entry.generalPurposeBitFlag & ~ALLOWED_FLAGS) !== 0
      || (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
      || !Number.isSafeInteger(entry.uncompressedSize) || !Number.isSafeInteger(entry.compressedSize)) invalid();
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if ((entry.externalFileAttributes & 0x10) !== 0 || (mode !== 0 && (mode & 0xf000) !== 0x8000)) invalid();
  return extras(entry.extraFieldRaw);
}

// Preview never extracts, executes or installs anything; returned data excludes paths and contents.
// One reader serves every versioned tree format; the spec fixes the marker, entry names and quotas.
async function walkTreeArchive(path: string, spec: TreeArchiveSpec, options: LiteralPreviewOptions = {}, visitor?: TreeVisitor): Promise<LiteralPreview> {
  const { signal } = options;
  checkAbort(signal);
  const maxExpandedBytes = options.maxExpandedBytes ?? spec.defaultPreviewBytes;
  if (!Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes < 0
      || maxExpandedBytes > spec.totalBytesLimit) throw new StorageError('limit-exceeded');
  let file: FileHandle | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1) invalid();
    file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    const opened = await file.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) invalid();
    const central = await layout(file, opened.size, spec);
    const zip = await yauzl.fromFdPromise(file.fd, {
      autoClose: false, lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true,
    });
    if (zip.entryCount !== central.count || zip.comment !== '') invalid();
    let centralCursor = central.offset;
    let localCursor = 0;
    let manifest: LiteralManifest | undefined;
    let files = 0;
    let directories = 0;
    let symlinks = 0;
    let seen = 0;
    const fileEntries: { path: string; mode: number; size: number; sha256: string }[] = [];
    for await (const entry of zip.eachEntry()) {
      checkAbort(signal);
      seen++;
      if (seen > central.count) invalid();
      const header = await bytesAt(file, centralCursor, 46);
      if (header.readUInt32LE(0) !== 0x02014b50 || header.readUInt16LE(28) !== entry.fileNameLength
          || header.readUInt16LE(30) !== entry.extraFieldLength || header.readUInt16LE(32) !== entry.fileCommentLength) invalid();
      centralCursor += 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength;
      if (centralCursor > central.end) invalid();
      const expectedName = seen === 1 ? spec.manifestName : `${spec.payloadPrefix}${String(seen - 1).padStart(6, '0')}`;
      const centralExtras = entryName(entry, expectedName, 32);
      const centralZip64 = centralExtras.get(0x0001);
      // Our writer stores [uncompressed, compressed, localOffset] in the central ZIP64 extra when forced.
      if (centralZip64 && centralZip64.length === 24
          && (uint64(centralZip64, 0) !== entry.uncompressedSize || uint64(centralZip64, 8) !== entry.compressedSize
              || uint64(centralZip64, 16) !== entry.relativeOffsetOfLocalHeader)) invalid();
      if (entry.relativeOffsetOfLocalHeader !== localCursor) invalid();
      const local = await zip.readLocalFileHeaderPromise(entry);
      const localExtras = extras(local.extraField);
      const zip64 = localExtras.get(0x0001);
      if (zip64 && (zip64.length !== 16 || uint64(zip64, 0) !== entry.uncompressedSize
          || uint64(zip64, 8) !== entry.compressedSize)) invalid();
      const deferred = local.crc32 === 0 && local.compressedSize === 0 && local.uncompressedSize === 0;
      const matching = local.crc32 === entry.crc32 && local.compressedSize === entry.compressedSize
        && local.uncompressedSize === entry.uncompressedSize;
      const zip64Sizes = Boolean(zip64) && local.compressedSize === 0xffffffff
        && local.uncompressedSize === 0xffffffff && local.crc32 === 0;
      if (!local.fileName.equals(entry.fileNameRaw) || local.generalPurposeBitFlag !== entry.generalPurposeBitFlag
          || local.compressionMethod !== entry.compressionMethod
          || (!matching && ((entry.generalPurposeBitFlag & 0x0008) === 0 || (!deferred && !zip64Sizes)))) invalid();
      const dataEnd = local.fileDataStart + entry.compressedSize;
      if (!Number.isSafeInteger(dataEnd) || dataEnd > central.offset) invalid();
      // A data descriptor uses 8-byte sizes when the entry is ZIP64 anywhere, not only when the local
      // header carries the extra: streamed ZIP64 entries keep zero local sizes and no local extra.
      localCursor = dataEnd + await descriptorSize(file, entry, dataEnd, central.offset, Boolean(zip64) || Boolean(centralZip64));
      if (localCursor > central.offset) invalid();
      if (seen === 1) {
        if (entry.uncompressedSize > spec.manifestBytes) throw new StorageError('limit-exceeded');
        const raw = await digestEntry(zip, entry, spec.manifestBytes, undefined, signal);
        if (!raw || raw.toString('utf8') !== new TextDecoder('utf-8', { fatal: true }).decode(raw)) invalid();
        manifest = spec.validateManifest(JSON.parse(raw.toString('utf8')));
        for (const item of manifest.entries) {
          if (item.type === 'file') fileEntries.push({ path: item.path, mode: item.mode, size: item.size, sha256: item.sha256 });
          if (item.type === 'directory') {
            directories++;
            await visitor?.directory(item.path, item.mode);
          }
          if (item.type === 'symlink') {
            symlinks++;
            await visitor?.symlink(item.path, item.target);
          }
        }
        if (central.count !== fileEntries.length + 1) invalid();
        if (manifest.totalBytes > maxExpandedBytes) throw new StorageError('limit-exceeded');
      } else {
        const expected = fileEntries[seen - 2];
        if (!expected || entry.uncompressedSize !== expected.size) invalid();
        const writer = visitor ? await visitor.file(expected.path, expected.mode) : undefined;
        try {
          await digestEntry(zip, entry, expected.size, expected.sha256, signal,
            writer ? (chunk: Buffer) => writer.write(chunk) : undefined);
        } finally {
          await writer?.close();
        }
        files++;
      }
    }
    if (!manifest || seen !== central.count || localCursor !== central.offset || centralCursor !== central.end) invalid();
    checkAbort(signal);
    const after = await file.stat();
    const currentPath = await lstat(path);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
        || currentPath.dev !== opened.dev || currentPath.ino !== opened.ino || !currentPath.isFile()) invalid();
    return Object.freeze({ sourcePlatform: manifest.sourcePlatform, files, directories, symlinks, totalBytes: manifest.totalBytes });
  } catch (error) {
    if (signal?.aborted) throw new StorageError('aborted');
    if (error instanceof StorageError) throw error;
    throw new StorageError('invalid-state');
  } finally {
    await file?.close();
  }
}

export async function previewLiteralArchive(path: string, options: LiteralPreviewOptions = {}): Promise<LiteralPreview> {
  return walkTreeArchive(path, LITERAL_ARCHIVE_SPEC, options);
}

export async function previewTreeArchive(path: string, spec: TreeArchiveSpec, options: LiteralPreviewOptions = {}): Promise<LiteralPreview> {
  return walkTreeArchive(path, spec, options);
}

// Second pass: materializes a verified archive into a directory that must not exist yet.
//
// Directory-descriptor operations are not available in Node, so the tree is built under a name created
// exclusively with 128 random bits, an ownership token is written next to it, and both identities plus the
// token content are re-verified before anything is published or removed. Nothing is ever deleted without
// that proof: a failure that loses it is reported as `recovery-required` and the paths are left for review.
// The remaining window is documented in the reliability notes: a process that learns the random name from
// the parent listing and swaps the temporary between `mkdir` and the token write can make this call write
// into its directory; publishing and deleting require the proof, so at worst that directory stays there.
export async function materializeTreeArchive(path: string, destination: string, spec: TreeArchiveSpec,
  options: LiteralMaterializeOptions = {}): Promise<LiteralPreview> {
  if (typeof destination !== 'string' || !isAbsolute(destination)) throw new StorageError('unsafe-path');
  if (await lstat(destination).then(() => true, () => false)) throw new StorageError('unsafe-path');
  const parent = dirname(destination);
  let temporary = '';
  let directory: Stats | undefined;
  for (let attempt = 0; attempt < 2 && !directory; attempt++) {
    temporary = join(parent, `.${basename(destination)}.${randomUUID()}.${randomUUID()}.tmp`);
    try {
      await mkdir(temporary, { mode: 0o700 });
      directory = await lstat(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
      throw new StorageError('unavailable');
    }
  }
  if (!directory) throw new StorageError('unavailable');

  // Ownership token: a file only this call created, kept beside the tree so the published tree stays clean.
  const tokenPath = `${temporary}.owner`;
  const tokenValue = randomUUID();
  let token: Stats;
  try {
    const handle = await open(tokenPath, 'wx', 0o600);
    try {
      await handle.writeFile(tokenValue, 'utf8');
      await handle.sync();
      token = await handle.stat();
    } finally { await handle.close(); }
  } catch {
    // Without the token there is no proof of ownership, so nothing is removed and the state is reported as
    // ambiguous for the operator or the auxiliary to inspect.
    throw new StorageError('recovery-required');
  }
  const owner: MaterializedOwner = Object.freeze({ directory, token, value: tokenValue });

  const visitor: TreeVisitor = {
    async directory(relative, mode) { await mkdir(join(temporary, relative), { mode: mode || 0o700 }); },
    async symlink(relative, target) { await symlink(target, join(temporary, relative)); },
    async file(relative, mode) {
      const handle = await open(join(temporary, relative), 'wx', mode || 0o600);
      return {
        write: async (chunk: Buffer) => { await handle.write(chunk); },
        close: async () => { await handle.close(); },
      };
    },
  };
  try {
    const preview = await walkTreeArchive(path, spec, options, visitor);
    // The tree is complete: refuse to publish unless both identities and the token content still match.
    if (!await verifiedTemporary(temporary, tokenPath, owner)) throw new StorageError('recovery-required');
    await options.onStaged?.(temporary);
    // Verified again after the seam: the only operations that touch something other than this call's own
    // temporary are the publication and the cleanup, and both require this proof.
    if (!await verifiedTemporary(temporary, tokenPath, owner)) throw new StorageError('recovery-required');
    if (await lstat(destination).then(() => true, () => false)) throw new StorageError('unsafe-path');
    await unlink(tokenPath).catch(() => undefined);
    await rename(temporary, destination);
    const published = await lstat(destination).catch(() => undefined);
    if (!published?.isDirectory() || published.dev !== owner.directory.dev || published.ino !== owner.directory.ino) {
      throw new StorageError('recovery-required');
    }
    return preview;
  } catch (error) {
    if (error instanceof StorageError && error.code === 'recovery-required') throw error;
    await removeOwnTemporary(temporary, tokenPath, owner);
    throw error;
  }
}

// Removes the temporary tree and its token only while both are provably the ones this call created.
async function removeOwnTemporary(temporary: string, tokenPath: string, owner: MaterializedOwner | undefined): Promise<void> {
  if (owner && !await verifiedTemporary(temporary, tokenPath, owner)) {
    throw new StorageError('recovery-required');
  }
  await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  await unlink(tokenPath).catch(() => undefined);
}

async function verifiedTemporary(temporary: string, tokenPath: string, owner: MaterializedOwner): Promise<boolean> {
  const directory = await lstat(temporary).catch(() => undefined);
  if (!directory?.isDirectory() || directory.dev !== owner.directory.dev || directory.ino !== owner.directory.ino) return false;
  const token = await lstat(tokenPath).catch(() => undefined);
  if (!token?.isFile() || token.dev !== owner.token.dev || token.ino !== owner.token.ino) return false;
  const value = await readFile(tokenPath, 'utf8').catch(() => '');
  return value === owner.value;
}

export async function materializeLiteralArchive(path: string, destination: string, options: LiteralMaterializeOptions = {}): Promise<LiteralPreview> {
  return materializeTreeArchive(path, destination, LITERAL_ARCHIVE_SPEC, options);
}
