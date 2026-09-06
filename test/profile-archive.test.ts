import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import * as yazl from 'yazl';
import { createProfileArchive, parseProfileArchive, PROFILE_ARCHIVE_LIMITS } from '../src/profile-archive.ts';

const profile = Buffer.from('{"format":"pi-setup-share","version":1,"resources":[]}\n');

function centralDirectoryOffset(archive: Buffer): number {
  const offset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.notEqual(offset, -1);
  return offset;
}

async function zip(entries: readonly [string, Buffer][], comment = ''): Promise<Buffer> {
  const archive = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  archive.outputStream.on('data', chunk => chunks.push(Buffer.from(chunk)));
  for (const [name, bytes] of entries) archive.addBuffer(bytes, name, {
    mtime: new Date('1980-01-01T00:00:00.000Z'), forceDosTimestamp: true, mode: 0o100600,
  });
  archive.end({ forceZip64Format: false, comment });
  await once(archive.outputStream, 'end');
  return Buffer.concat(chunks);
}

test('creates a deterministic single-entry ZIP and returns the profile bytes', async () => {
  const first = await createProfileArchive(profile);
  const second = await createProfileArchive(profile);
  assert.equal(first.subarray(0, 4).toString('hex'), '504b0304');
  assert.deepEqual(second, first);
  assert.deepEqual(await parseProfileArchive(first), profile);
});

test('accepts only one profile.json entry without archive comments', async () => {
  await assert.rejects(parseProfileArchive(await zip([['other.json', profile]])), { code: 'invalid-state' });
  await assert.rejects(parseProfileArchive(await zip([['profile.json', profile], ['extra.txt', Buffer.from('extra')]])), { code: 'invalid-state' });
  await assert.rejects(parseProfileArchive(await zip([['profile.json', profile]], 'comment')), { code: 'invalid-state' });
});

test('rejects contradictory local headers, encryption, directories and links', async () => {
  const valid = await zip([['profile.json', profile]]);
  const central = centralDirectoryOffset(valid);
  const localEncrypted = Buffer.from(valid);
  localEncrypted.writeUInt16LE(localEncrypted.readUInt16LE(6) | 1, 6);
  await assert.rejects(parseProfileArchive(localEncrypted), { code: 'invalid-state' });
  const encrypted = Buffer.from(localEncrypted);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  await assert.rejects(parseProfileArchive(encrypted), { code: 'invalid-state' });
  const renamed = Buffer.from(valid);
  renamed.write('evilfile.txt', 30, 'ascii');
  await assert.rejects(parseProfileArchive(renamed), { code: 'invalid-state' });
  const directory = Buffer.from(valid);
  directory.writeUInt32LE((directory.readUInt32LE(central + 38) | 0x10) >>> 0, central + 38);
  await assert.rejects(parseProfileArchive(directory), { code: 'invalid-state' });
  const symlink = Buffer.from(valid);
  symlink.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
  await assert.rejects(parseProfileArchive(symlink), { code: 'invalid-state' });
});

test('rejects an undeclared local entry before the central directory', async () => {
  const valid = await zip([['profile.json', profile]]);
  const orphanSource = await zip([['extra.txt', Buffer.from('extra')]]);
  const central = centralDirectoryOffset(valid);
  const orphan = orphanSource.subarray(0, centralDirectoryOffset(orphanSource));
  const archive = Buffer.concat([valid.subarray(0, central), orphan, valid.subarray(central)]);
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocd, -1);
  archive.writeUInt32LE(central + orphan.length, eocd + 16);
  await assert.rejects(parseProfileArchive(archive), { code: 'invalid-state' });
});

test('rejects undeclared bytes inside the central directory range', async () => {
  const valid = await zip([['profile.json', profile]]);
  const orphanSource = await zip([['orphan.txt', Buffer.from('orphan')]]);
  const orphan = orphanSource.subarray(0, centralDirectoryOffset(orphanSource));
  const oldEocd = valid.length - 22;
  const oldSize = valid.readUInt32LE(oldEocd + 12);
  const archive = Buffer.concat([valid.subarray(0, oldEocd), orphan, valid.subarray(oldEocd)]);
  const eocd = archive.length - 22;
  archive.writeUInt32LE(oldSize + orphan.length, eocd + 12);
  await assert.rejects(parseProfileArchive(archive), { code: 'invalid-state' });
});

test('rejects residual central extra-field bytes', async () => {
  const valid = await zip([['profile.json', profile]]);
  const central = centralDirectoryOffset(valid);
  const oldEocd = valid.length - 22;
  const oldSize = valid.readUInt32LE(oldEocd + 12);
  const insertion = central + 46 + valid.readUInt16LE(central + 28);
  const archive = Buffer.concat([valid.subarray(0, insertion), Buffer.from([0]), valid.subarray(insertion)]);
  archive.writeUInt16LE(1, central + 30);
  const eocd = archive.length - 22;
  archive.writeUInt32LE(oldSize + 1, eocd + 12);
  await assert.rejects(parseProfileArchive(archive), { code: 'invalid-state' });
});

test('rejects a mismatched CRC and an oversized declared profile before accepting bytes', async () => {
  const valid = await zip([['profile.json', profile]]);
  const central = centralDirectoryOffset(valid);
  const badCrc = Buffer.from(valid);
  badCrc.writeUInt32LE((badCrc.readUInt32LE(central + 16) + 1) >>> 0, central + 16);
  await assert.rejects(parseProfileArchive(badCrc), { code: 'invalid-state' });
  const oversized = Buffer.from(valid);
  oversized.writeUInt32LE(PROFILE_ARCHIVE_LIMITS.profileBytes + 1, central + 24);
  await assert.rejects(parseProfileArchive(oversized), { code: 'invalid-state' });
});

test('rejects malformed, oversized and cancelled archives without returning library errors', async () => {
  await assert.rejects(parseProfileArchive(Buffer.from('PK\x03\x04broken')), { code: 'invalid-state' });
  await assert.rejects(parseProfileArchive(Buffer.alloc(PROFILE_ARCHIVE_LIMITS.archiveBytes + 1)), { code: 'limit-exceeded' });
  await assert.rejects(createProfileArchive(profile, AbortSignal.abort()), { code: 'aborted' });
  await assert.rejects(parseProfileArchive(await zip([['profile.json', profile]]), AbortSignal.abort()), { code: 'aborted' });
});
