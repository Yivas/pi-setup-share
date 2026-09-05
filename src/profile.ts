import { Buffer } from 'node:buffer';
import { validateIntegrations, type PortableIntegrations } from './integrations.ts';
import { validatePackages, type PortablePackage } from './packages.ts';
import { validatePreferences, type PortablePreferences } from './preferences.ts';
import { validateKeybindings, type PortableKeybindings } from './keybindings.ts';
import { ProfileError, requireRecord, requireDataArray } from './validation.ts';
export { ProfileError, type ProfileErrorCode } from './validation.ts';

export const PROFILE_LIMITS = Object.freeze({
  jsonBytes: 16 * 1024 * 1024,
  depth: 8,
  resources: 256,
  fileBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  pathBytes: 240,
  segmentBytes: 100,
});

const RESOURCE_KINDS = ['extension', 'skill', 'prompt', 'theme', 'agent'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export type ResourceEncoding = 'utf8' | 'base64';

export interface ProfileResource {
  kind: ResourceKind;
  path: string;
  encoding: ResourceEncoding;
  content: string;
}

export interface ResourceProfile {
  format: 'pi-setup-share';
  version: 1;
  resources: ProfileResource[];
  preferences?: PortablePreferences;
  keybindings?: PortableKeybindings;
  integrations?: PortableIntegrations;
  packages?: PortablePackage[];
}

function portablePath(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0
      || Buffer.byteLength(value, 'utf8') > PROFILE_LIMITS.pathBytes
      || value !== value.normalize('NFC')
      || /[\p{C}<>:"\\|?*]/u.test(value)) {
    throw new ProfileError('invalid-path', field);
  }
  for (const segment of value.split('/')) {
    if (!segment || segment === '.' || segment === '..'
        || /^[ .]|[ .]$/.test(segment)
        || Buffer.byteLength(segment, 'utf8') > PROFILE_LIMITS.segmentBytes
        || /^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)) {
      throw new ProfileError('invalid-path', field);
    }
  }
}

function contentBytes(resource: ProfileResource, field: string): number {
  const { content, encoding } = resource;
  if (encoding === 'utf8') {
    const size = Buffer.byteLength(content, 'utf8');
    if (size > PROFILE_LIMITS.fileBytes) throw new ProfileError('limit-exceeded', field);
    if (Buffer.from(content, 'utf8').toString('utf8') !== content) {
      throw new ProfileError('invalid-content', field);
    }
    return size;
  }
  if (content.length > 4 * Math.ceil(PROFILE_LIMITS.fileBytes / 3)) {
    throw new ProfileError('limit-exceeded', field);
  }
  // Buffer's decoder accepts whitespace and malformed padding; require a canonical round trip.
  const decoded = Buffer.from(content, 'base64');
  if (decoded.toString('base64') !== content) throw new ProfileError('invalid-content', field);
  if (decoded.length > PROFILE_LIMITS.fileBytes) throw new ProfileError('limit-exceeded', field);
  return decoded.length;
}

export function validateProfile(value: unknown): ResourceProfile {
  requireRecord(value, ['format', 'version', 'resources'], 'profile', ['preferences', 'keybindings', 'integrations', 'packages']);
  if (value.format !== 'pi-setup-share') throw new ProfileError('invalid-shape', 'format');
  if (value.version !== 1) throw new ProfileError('unsupported-version', 'version');
  requireDataArray(value.resources, PROFILE_LIMITS.resources, 'resources');

  const resources: ProfileResource[] = [];
  const paths = new Map<string, number>();
  let totalBytes = 0;
  for (let index = 0; index < value.resources.length; index++) {
    const entry: unknown = value.resources[index];
    const field = `resources[${index}]`;
    requireRecord(entry, ['kind', 'path', 'encoding', 'content'], field);
    if (!RESOURCE_KINDS.some(kind => kind === entry.kind)
        || (entry.encoding !== 'utf8' && entry.encoding !== 'base64')
        || typeof entry.content !== 'string') {
      throw new ProfileError('invalid-shape', field);
    }
    portablePath(entry.path, `${field}.path`);
    const resource: ProfileResource = {
      kind: entry.kind as ResourceKind, path: entry.path,
      encoding: entry.encoding, content: entry.content,
    };
    totalBytes += contentBytes(resource, `${field}.content`);
    if (totalBytes > PROFILE_LIMITS.totalBytes) throw new ProfileError('limit-exceeded', 'resources');
    // Lowercase first so both ẞ and ß fold to SS. This is lexical, not filesystem equivalence.
    const key = `${resource.kind}/${resource.path}`.toLowerCase().toUpperCase().normalize('NFC');
    if (paths.has(key)) throw new ProfileError('path-conflict', `${field}.path`);
    paths.set(key, index);
    resources.push(resource);
  }
  for (const [path, index] of paths) {
    const segments = path.split('/');
    for (let length = 1; length < segments.length; length++) {
      if (paths.has(segments.slice(0, length).join('/'))) {
        throw new ProfileError('path-conflict', `resources[${index}].path`);
      }
    }
  }
  const profile: ResourceProfile = { format: 'pi-setup-share', version: 1, resources };
  if (Object.hasOwn(value, 'preferences')) profile.preferences = validatePreferences(value.preferences);
  if (Object.hasOwn(value, 'keybindings')) profile.keybindings = validateKeybindings(value.keybindings);
  if (Object.hasOwn(value, 'integrations')) profile.integrations = validateIntegrations(value.integrations);
  if (Object.hasOwn(value, 'packages')) profile.packages = validatePackages(value.packages);
  return profile;
}

function checkJsonDepth(text: string): void {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {
      if (++depth > PROFILE_LIMITS.depth) throw new ProfileError('limit-exceeded', 'profile');
    } else if (character === '}' || character === ']') depth--;
  }
}

export function parseProfile(text: string): ResourceProfile {
  if (Buffer.byteLength(text, 'utf8') > PROFILE_LIMITS.jsonBytes) {
    throw new ProfileError('limit-exceeded', 'profile');
  }
  checkJsonDepth(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProfileError('invalid-json', 'profile');
  }
  return validateProfile(value);
}
