import type { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import { PROFILE_LIMITS } from './profile.ts';
import { StorageError } from './storage.ts';

const ENTRY_NAME = 'profile.json';
export const PROFILE_ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: PROFILE_LIMITS.jsonBytes + 1024 * 1024,
  profileBytes: PROFILE_LIMITS.jsonBytes,
});

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StorageError('aborted');
}

function translateArchiveError(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted) throw new StorageError('aborted');
  if (error instanceof StorageError) throw error;
  throw new StorageError('invalid-state');
}

async function collect(stream: Readable, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => stream.destroy(new StorageError('aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) {
      checkAbort(signal);
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) throw new StorageError('limit-exceeded');
      chunks.push(bytes);
    }
    checkAbort(signal);
    return Buffer.concat(chunks, size);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export function isProfileArchive(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function centralDirectoryLayout(bytes: Buffer): { offset: number; size: number } {
  const eocd = bytes.length - 22;
  if (eocd < 0 || bytes.readUInt32LE(eocd) !== 0x06054b50
      || bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0
      || bytes.readUInt16LE(eocd + 8) !== 1 || bytes.readUInt16LE(eocd + 10) !== 1
      || bytes.readUInt16LE(eocd + 20) !== 0) throw new StorageError('invalid-state');
  const size = bytes.readUInt32LE(eocd + 12);
  const offset = bytes.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || size === 0xffffffff || offset + size !== eocd
      || size < 46 || bytes.readUInt32LE(offset) !== 0x02014b50) throw new StorageError('invalid-state');
  const recordSize = 46 + bytes.readUInt16LE(offset + 28)
    + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  if (recordSize !== size) throw new StorageError('invalid-state');
  return { offset, size };
}

function physicalLayoutMatches(
  bytes: Buffer, centralOffset: number, entry: yauzl.Entry, local: yauzl.LocalFileHeader,
): boolean {
  if (entry.relativeOffsetOfLocalHeader !== 0) return false;
  const dataEnd = local.fileDataStart + entry.compressedSize;
  if (!Number.isSafeInteger(dataEnd) || dataEnd > centralOffset) return false;
  const usesDataDescriptor = (entry.generalPurposeBitFlag & 0x0008) !== 0;
  if (!usesDataDescriptor) return dataEnd === centralOffset;
  const descriptorSize = centralOffset - dataEnd;
  if (descriptorSize !== 12 && descriptorSize !== 16) return false;
  let cursor = dataEnd;
  if (descriptorSize === 16) {
    if (bytes.readUInt32LE(cursor) !== 0x08074b50) return false;
    cursor += 4;
  }
  return bytes.readUInt32LE(cursor) === entry.crc32
    && bytes.readUInt32LE(cursor + 4) === entry.compressedSize
    && bytes.readUInt32LE(cursor + 8) === entry.uncompressedSize;
}

export async function createProfileArchive(profileJson: Uint8Array, signal?: AbortSignal): Promise<Buffer> {
  checkAbort(signal);
  if (profileJson.byteLength > PROFILE_ARCHIVE_LIMITS.profileBytes) throw new StorageError('limit-exceeded');
  const archive = new yazl.ZipFile();
  archive.addBuffer(Buffer.from(profileJson), ENTRY_NAME, {
    mtime: new Date('1980-01-01T00:00:00.000Z'),
    mode: 0o100600,
    compress: true,
    forceZip64Format: false,
    forceDosTimestamp: true,
    compressionLevel: 9,
  });
  archive.end({ forceZip64Format: false, comment: '' });
  try {
    return await collect(archive.outputStream as Readable, PROFILE_ARCHIVE_LIMITS.archiveBytes, signal);
  } catch (error) {
    return translateArchiveError(error, signal);
  }
}

export async function parseProfileArchive(bytes: Uint8Array, signal?: AbortSignal): Promise<Buffer> {
  checkAbort(signal);
  if (bytes.byteLength > PROFILE_ARCHIVE_LIMITS.archiveBytes) throw new StorageError('limit-exceeded');
  if (!isProfileArchive(bytes)) throw new StorageError('invalid-state');
  const input = Buffer.from(bytes);
  let archive: yauzl.ZipFile | undefined;
  try {
    const central = centralDirectoryLayout(input);
    archive = await yauzl.fromBufferPromise(input, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });
    if (archive.entryCount !== 1 || archive.comment !== '') throw new StorageError('invalid-state');
    const iterator = archive.eachEntry();
    const result = await iterator.next();
    const entry = result.value;
    const allowedFlags = 0x0008 | 0x0800;
    if (result.done || !entry || entry.fileName !== ENTRY_NAME || entry.fileComment !== ''
        || entry.extraFieldLength !== 0 || entry.extraFieldRaw.length !== 0 || entry.extraFields.length !== 0
        || entry.isEncrypted() || !entry.canDecodeFileData()
        || (entry.generalPurposeBitFlag & ~allowedFlags) !== 0
        || (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
        || entry.uncompressedSize > PROFILE_ARCHIVE_LIMITS.profileBytes
        || (entry.externalFileAttributes & 0x10) !== 0) {
      throw new StorageError('invalid-state');
    }
    const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
    if (mode !== 0 && (mode & 0xf000) !== 0x8000) throw new StorageError('invalid-state');
    const local = await archive.readLocalFileHeaderPromise(entry);
    const usesDataDescriptor = (entry.generalPurposeBitFlag & 0x0008) !== 0;
    const localSizesMatch = local.crc32 === entry.crc32
      && local.compressedSize === entry.compressedSize
      && local.uncompressedSize === entry.uncompressedSize;
    const localSizesDeferred = local.crc32 === 0 && local.compressedSize === 0 && local.uncompressedSize === 0;
    if (!local.fileName.equals(Buffer.from(ENTRY_NAME)) || local.extraFieldLength !== 0
        || local.generalPurposeBitFlag !== entry.generalPurposeBitFlag
        || local.compressionMethod !== entry.compressionMethod
        || (!usesDataDescriptor && !localSizesMatch)
        || (usesDataDescriptor && !localSizesMatch && !localSizesDeferred)
        || !physicalLayoutMatches(input, central.offset, entry, local)) {
      throw new StorageError('invalid-state');
    }
    checkAbort(signal);
    const stream = await archive.openReadStreamPromise(entry);
    const profile = await collect(stream, PROFILE_ARCHIVE_LIMITS.profileBytes, signal);
    if (profile.length !== entry.uncompressedSize || (crc32(profile) >>> 0) !== entry.crc32) throw new StorageError('invalid-state');
    const next = await iterator.next();
    if (!next.done) throw new StorageError('invalid-state');
    return profile;
  } catch (error) {
    return translateArchiveError(error, signal);
  } finally {
    archive?.close();
  }
}
