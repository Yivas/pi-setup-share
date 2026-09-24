// Receiver backup archive: the compressed copy of the receiving agent directory that the deferred swap
// takes before replacing it. It is a separate format with its own marker, reader and writer, so a
// literal export archive and a receiver backup can never be mistaken for each other, and neither is
// ever interpreted as a portable profile. Both reuse the shared entry parser, quotas and byte checks.
import { previewTreeArchive, type LiteralPreview, type LiteralPreviewOptions } from './literal-archive.ts';
import { BACKUP_ARCHIVE_SPEC } from './literal-manifest.ts';
import { writeTreeArchive, type LiteralWriterOptions, type LiteralWriterResult } from './literal-writer.ts';

// Read-only preview: never extracts, executes or installs; returns counts and the total size only.
export async function previewReceiverBackup(path: string, options: LiteralPreviewOptions = {}): Promise<LiteralPreview> {
  return previewTreeArchive(path, BACKUP_ARCHIVE_SPEC, options);
}

// Writes the backup exactly like the literal writer: verified streaming, an exclusively created
// temporary re-read by the reader, and an exclusive-link publication that never replaces a file.
export async function writeReceiverBackup(root: string, destination: string, options: LiteralWriterOptions = {}): Promise<LiteralWriterResult> {
  return writeTreeArchive(root, destination, BACKUP_ARCHIVE_SPEC, options);
}
