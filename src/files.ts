import { Buffer, isUtf8 } from 'node:buffer';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { PROFILE_LIMITS, assertPortableResourceRoot, validateProfile, type ProfileResource, type ResourceKind } from './profile.ts';
import { ProfileError, requireDataArray, requireRecord } from './validation.ts';

export interface ResourceSelection { kind: ResourceKind; path: string }
export interface ResourceCandidate extends ResourceSelection { entrypoint: boolean }
export interface ResourceInventory { candidates: ResourceCandidate[]; omitted: number; truncated: boolean }
export type ResourceReadErrorCode = 'unavailable' | 'not-file' | 'link' | 'changed' | 'limit-exceeded' | 'aborted';

export class ResourceReadError extends Error {
  readonly code: ResourceReadErrorCode;
  readonly field: string;

  constructor(code: ResourceReadErrorCode, field: string) {
    super(code);
    this.name = 'ResourceReadError';
    this.code = code;
    this.field = field;
  }
}

function checkAbort(signal: AbortSignal | undefined, field: string): void {
  if (signal?.aborted) throw new ResourceReadError('aborted', field);
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function checkedPath(root: string, rootStat: BigIntStats, path: string, field: string): Promise<BigIntStats> {
  let current = root;
  let stat = await lstat(current, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(stat, rootStat)) {
    throw new ResourceReadError('changed', field);
  }
  const segments = path.split('/');
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index] as string);
    stat = await lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) throw new ResourceReadError('link', field);
    if (index < segments.length - 1 && !stat.isDirectory()) throw new ResourceReadError('not-file', field);
  }
  if (!stat.isFile()) throw new ResourceReadError('not-file', field);
  if (stat.nlink !== 1n) throw new ResourceReadError('link', field);
  const resolved = relative(root, await realpath(current));
  if (resolved === '..' || resolved.startsWith(`..${sep}`) || isAbsolute(resolved)) {
    throw new ResourceReadError('link', field);
  }
  return stat;
}

async function readResource(
  root: string, rootStat: BigIntStats, resource: ProfileResource, field: string, signal?: AbortSignal,
): Promise<ProfileResource> {
  checkAbort(signal, field);
  const before = await checkedPath(root, rootStat, resource.path, field);
  if (before.size > BigInt(PROFILE_LIMITS.fileBytes)) throw new ResourceReadError('limit-exceeded', field);
  const handle = await open(join(root, resource.path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened) || opened.nlink !== 1n) {
      throw new ResourceReadError('changed', field);
    }
    // One extra byte detects growth without an unbounded readFile allocation.
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      checkAbort(signal, field);
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    checkAbort(signal, field);
    const after = await handle.stat({ bigint: true });
    const destination = await checkedPath(root, rootStat, resource.path, field);
    if (!sameFile(before, after) || !sameFile(before, destination) || BigInt(length) !== before.size) {
      throw new ResourceReadError('changed', field);
    }
    const bytes = buffer.subarray(0, length);
    const encoding = isUtf8(bytes) ? 'utf8' : 'base64';
    return { kind: resource.kind, path: resource.path, encoding, content: bytes.toString(encoding === 'utf8' ? 'utf8' : 'base64') };
  } finally {
    await handle.close();
  }
}

// Enumerate names only. Reading selected content remains the responsibility of exportResources.
export async function discoverResources(
  root: string, kind: ResourceKind, signal?: AbortSignal, maxEntries = 1024, skipRootDirectories: readonly string[] = [],
): Promise<ResourceInventory> {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')
      || !['extension', 'skill', 'prompt', 'theme', 'agent'].includes(kind)
      || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1024) {
    throw new ProfileError('invalid-path', 'inventory');
  }
  assertPortableResourceRoot(root);
  const candidates: ResourceCandidate[] = [];
  let omitted = 0;
  let visited = 0;
  let truncated = false;
  const deadline = Date.now() + 5_000; // Cooperative; an in-flight filesystem call cannot be interrupted.
  try {
    checkAbort(signal, 'inventory');
    let rootInfo: Awaited<ReturnType<typeof lstat>>;
    try { rootInfo = await lstat(root); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { candidates: [], omitted: 0, truncated: false };
      throw error;
    }
    assertPortableResourceRoot(await realpath(root));
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new ResourceReadError('link', 'inventory');
    async function visit(directory: string, prefix: string, depth: number): Promise<void> {
      checkAbort(signal, 'inventory');
      if (Date.now() > deadline) { truncated = true; return; }
      // opendir bounds memory even if a user directory contains millions of entries.
      const entries = await opendir(directory);
      for await (const entry of entries) {
        checkAbort(signal, 'inventory');
        if (Date.now() > deadline || ++visited > maxEntries) { truncated = true; break; }
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) { omitted++; continue; }
        try { validateProfile({ format: 'pi-setup-share', version: 1, resources: [
          { kind, path, encoding: 'utf8', content: '' },
        ] }); } catch (error) {
          if (!(error instanceof ProfileError)) throw error;
          omitted++;
          continue;
        }
        if (entry.isDirectory()) {
          if (depth === 0 && skipRootDirectories.includes(entry.name)) continue;
          if (depth >= 4 || kind === 'prompt' || kind === 'theme') { omitted++; continue; }
          await visit(join(directory, entry.name), path, depth + 1);
          if (truncated) break;
          continue;
        }
        const name = entry.name;
        if (kind === 'skill' && depth === 0) { omitted++; continue; }
        const entrypoint = kind === 'extension' ? /\.(?:ts|js)$/.test(name) && (depth === 0 || /^index\.(?:ts|js)$/.test(name))
          : kind === 'skill' ? name === 'SKILL.md' && depth > 0
          : kind === 'prompt' ? depth === 0 && name.endsWith('.md') && !name.endsWith('.chain.md')
          : kind === 'theme' ? depth === 0 && name.endsWith('.json')
          : name.endsWith('.md') && !name.endsWith('.chain.md');
        if (kind === 'prompt' && !entrypoint || kind === 'theme' && !entrypoint) { omitted++; continue; }
        if (candidates.length >= PROFILE_LIMITS.resources) { omitted++; truncated = true; continue; }
        candidates.push({ kind, path, entrypoint });
      }
    }
    await visit(root, '', 0);
    if (Date.now() > deadline) truncated = true;
    candidates.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    return { candidates, omitted, truncated };
  } catch (error) {
    if (error instanceof ResourceReadError || error instanceof ProfileError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ResourceReadError('changed', 'inventory');
    throw new ResourceReadError('unavailable', 'inventory');
  }
}

export async function exportResources(
  root: string, selection: readonly ResourceSelection[], signal?: AbortSignal,
): Promise<ProfileResource[]> {
  requireDataArray(selection, PROFILE_LIMITS.resources, 'selection');
  const resources = selection.map((entry, index) => {
    requireRecord(entry, ['kind', 'path'], `selection[${index}]`);
    return { kind: entry.kind, path: entry.path, encoding: 'utf8', content: '' };
  });
  const validated = validateProfile({ format: 'pi-setup-share', version: 1, resources });
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw new ProfileError('invalid-path', 'root');
  assertPortableResourceRoot(root);
  let field = 'root';
  try {
    checkAbort(signal, field);
    const rootInfo = await lstat(root, { bigint: true });
    if (rootInfo.isSymbolicLink()) throw new ResourceReadError('link', field);
    if (!rootInfo.isDirectory()) throw new ResourceReadError('not-file', field);
    const canonicalRoot = await realpath(root);
    assertPortableResourceRoot(canonicalRoot);
    const rootStat = await lstat(canonicalRoot, { bigint: true });
    if (!sameIdentity(rootInfo, rootStat)) throw new ResourceReadError('changed', field);
    const output: ProfileResource[] = [];
    let totalBytes = 0;
    let jsonBytes = Buffer.byteLength(JSON.stringify({ format: 'pi-setup-share', version: 1, resources: [] }));
    for (let index = 0; index < validated.resources.length; index++) {
      field = `resources[${index}]`;
      const resource = await readResource(canonicalRoot, rootStat, validated.resources[index] as ProfileResource, field, signal);
      totalBytes += Buffer.byteLength(resource.content, resource.encoding === 'utf8' ? 'utf8' : 'base64');
      jsonBytes += Buffer.byteLength(JSON.stringify(resource)) + (index > 0 ? 1 : 0);
      if (totalBytes > PROFILE_LIMITS.totalBytes || jsonBytes > PROFILE_LIMITS.jsonBytes) {
        throw new ResourceReadError('limit-exceeded', field);
      }
      output.push(resource);
    }
    checkAbort(signal, field);
    return output;
  } catch (error) {
    if (error instanceof ResourceReadError || error instanceof ProfileError) throw error;
    // Node filesystem errors contain local paths; do not propagate them to profiles or UI.
    throw new ResourceReadError('unavailable', field);
  }
}
