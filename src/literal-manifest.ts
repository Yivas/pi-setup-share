import { Buffer } from 'node:buffer';
import { posix, win32 } from 'node:path';
import { StorageError } from './storage.ts';
import { ProfileError, requireDataArray, requireRecord } from './validation.ts';

export const LITERAL_MANIFEST_LIMITS = Object.freeze({
  entries: 250_000,
  totalBytes: 64 * 1024 ** 3,
  pathBytes: 1024,
  depth: 64,
});

type LiteralFile = Readonly<{ path: string; type: 'file'; mode: number; size: number; sha256: string }>;
type LiteralDirectory = Readonly<{ path: string; type: 'directory'; mode: number }>;
type LiteralSymlink = Readonly<{ path: string; type: 'symlink'; target: string }>;
export type LiteralEntry = LiteralFile | LiteralDirectory | LiteralSymlink;
export type LiteralManifest = Readonly<{
  format: 'pi-setup-share-literal';
  version: 1;
  root: 'agentDir';
  sourcePlatform: 'win32' | 'darwin' | 'linux';
  totalBytes: number;
  entries: readonly LiteralEntry[];
}>;

function invalid(code: 'invalid-state' | 'unsafe-path' | 'limit-exceeded'): never {
  throw new StorageError(code);
}

function safePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !path || path !== path.normalize('NFKC')
      || Buffer.byteLength(path, 'utf8') > LITERAL_MANIFEST_LIMITS.pathBytes
      || Buffer.from(path, 'utf8').toString('utf8') !== path
      || posix.isAbsolute(path) || win32.isAbsolute(path)
      || /[\p{C}<>:"\\|?*]/u.test(path)) invalid('unsafe-path');
  const parts = path.split('/');
  if (parts.length > LITERAL_MANIFEST_LIMITS.depth || parts.some(part => !part || part === '.' || part === '..'
      || /^[ .]|[ .]$/.test(part) || Buffer.byteLength(part, 'utf8') > 255
      || /^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) invalid('unsafe-path');
}

function mode(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0o777) invalid('invalid-state');
}

function numberInRange(value: unknown, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) invalid('limit-exceeded');
}

function validateLinkTarget(target: unknown): asserts target is string {
  if (typeof target !== 'string' || !target || target !== target.normalize('NFKC')
      || Buffer.byteLength(target, 'utf8') > LITERAL_MANIFEST_LIMITS.pathBytes
      || Buffer.from(target, 'utf8').toString('utf8') !== target
      || posix.isAbsolute(target) || win32.isAbsolute(target)
      || /[\p{C}<>:"\\|?*]/u.test(target)) invalid('unsafe-path');
}

// This boundary validates a manifest only; the ZIP reader must separately verify every byte and entry.
export function validateLiteralManifest(value: unknown): LiteralManifest {
  try {
    requireRecord(value, ['format', 'version', 'root', 'sourcePlatform', 'totalBytes', 'entries'], 'manifest');
    if (value.format !== 'pi-setup-share-literal' || value.version !== 1 || value.root !== 'agentDir'
        || !['win32', 'darwin', 'linux'].includes(value.sourcePlatform as string)) invalid('invalid-state');
    numberInRange(value.totalBytes, LITERAL_MANIFEST_LIMITS.totalBytes);
    requireDataArray(value.entries, LITERAL_MANIFEST_LIMITS.entries, 'entries');
    const entries: LiteralEntry[] = [];
    const paths = new Map<string, LiteralEntry>();
    let previous = '';
    let total = 0;
    for (const entry of value.entries) {
      requireRecord(entry, ['path', 'type'], 'entry', ['size', 'sha256', 'mode', 'target']);
      safePath(entry.path);
      if (previous && entry.path <= previous) invalid('invalid-state');
      previous = entry.path;
      const parent = posix.dirname(entry.path);
      if (parent !== '.' && paths.get(parent)?.type !== 'directory') invalid('invalid-state');
      let item: LiteralEntry;
      if (entry.type === 'file') {
        requireRecord(entry, ['path', 'type', 'mode', 'size', 'sha256'], 'file');
        mode(entry.mode);
        numberInRange(entry.size, LITERAL_MANIFEST_LIMITS.totalBytes);
        if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) invalid('invalid-state');
        total += entry.size;
        if (total > LITERAL_MANIFEST_LIMITS.totalBytes) invalid('limit-exceeded');
        item = Object.freeze({ path: entry.path, type: 'file', mode: entry.mode, size: entry.size, sha256: entry.sha256 });
      } else if (entry.type === 'directory') {
        requireRecord(entry, ['path', 'type', 'mode'], 'directory');
        mode(entry.mode);
        item = Object.freeze({ path: entry.path, type: 'directory', mode: entry.mode });
      } else if (entry.type === 'symlink') {
        requireRecord(entry, ['path', 'type', 'target'], 'symlink');
        validateLinkTarget(entry.target);
        item = Object.freeze({ path: entry.path, type: 'symlink', target: entry.target });
      } else invalid('invalid-state');
      paths.set(item.path, item);
      entries.push(item);
    }
    if (total !== value.totalBytes) invalid('invalid-state');
    // Conservative cross-platform comparison: a destination may fold more names than this locale.
    const collator = new Intl.Collator('und', { usage: 'search', sensitivity: 'base', ignorePunctuation: false });
    const comparablePaths = [...paths.keys()].sort(collator.compare);
    for (let index = 1; index < comparablePaths.length; index++) {
      const left = comparablePaths[index - 1];
      const right = comparablePaths[index];
      if (left === undefined || right === undefined) invalid('invalid-state');
      if (collator.compare(left, right) === 0) invalid('unsafe-path');
    }
    const resolvedLinks = new Map<string, string>();
    const resolving = new Set<string>();
    function resolveLink(link: LiteralSymlink, depth: number): string {
      const cached = resolvedLinks.get(link.path);
      if (cached) return cached;
      if (resolving.has(link.path)) invalid('unsafe-path');
      if (depth > LITERAL_MANIFEST_LIMITS.depth) invalid('limit-exceeded');
      resolving.add(link.path);
      let parts = posix.dirname(link.path) === '.' ? [] : posix.dirname(link.path).split('/');
      const components = link.target.split('/');
      if (components.length > 2 * LITERAL_MANIFEST_LIMITS.depth) invalid('limit-exceeded');
      for (let index = 0; index < components.length; index++) {
        const component = components[index];
        if (!component) invalid('unsafe-path');
        if (component === '.') continue;
        if (component === '..') {
          if (!parts.length) invalid('unsafe-path');
          parts.pop();
          continue;
        }
        parts.push(component);
        const candidate = parts.join('/');
        const target = paths.get(candidate);
        if (!target) invalid('unsafe-path');
        const resolvedTarget = target.type === 'symlink' ? paths.get(resolveLink(target, depth + 1)) : target;
        if (!resolvedTarget) invalid('unsafe-path');
        if (target.type === 'symlink') parts = resolvedTarget.path.split('/');
        if (index < components.length - 1 && resolvedTarget.type !== 'directory') invalid('unsafe-path');
      }
      const destination = parts.join('/');
      if (!destination || !paths.has(destination)) invalid('unsafe-path');
      resolving.delete(link.path);
      resolvedLinks.set(link.path, destination);
      return destination;
    }
    for (const entry of entries) if (entry.type === 'symlink') resolveLink(entry, 0);
    return Object.freeze({ format: 'pi-setup-share-literal', version: 1, root: 'agentDir',
      sourcePlatform: value.sourcePlatform as LiteralManifest['sourcePlatform'], totalBytes: total,
      entries: Object.freeze(entries) });
  } catch (error) {
    if (error instanceof ProfileError) invalid(error.code === 'limit-exceeded' ? 'limit-exceeded' : 'invalid-state');
    throw error;
  }
}
