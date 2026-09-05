import { isDeepStrictEqual } from 'node:util';
import { validateProfile, type ResourceProfile } from './profile.ts';
import { ProfileError, requireDataArray, requireDataRecord, requireRecord } from './validation.ts';

export type ConflictDecision = 'preserve' | 'overwrite';
export interface PreviewItem {
  id: string;
  status: 'new' | 'same' | 'conflict';
  action: 'write' | 'preserve';
}
export interface TargetConfiguration {
  settings?: Record<string, unknown>;
  keybindings?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
}
export interface ConfigurationPreview {
  items: PreviewItem[];
  configuration: Required<TargetConfiguration>;
}

function copyTarget(value: unknown): unknown {
  let nodes = 0;
  let bytes = 0;
  function visit(input: unknown, depth: number): unknown {
    if (++nodes > 65_536 || depth > 32) throw new ProfileError('limit-exceeded', 'target');
    if (typeof input === 'string') {
      bytes += Buffer.byteLength(input);
      if (bytes > 16 * 1024 * 1024) throw new ProfileError('limit-exceeded', 'target');
      return input;
    }
    if (input === null || typeof input === 'boolean' || (typeof input === 'number' && Number.isFinite(input))) return input;
    if (Array.isArray(input)) {
      requireDataArray(input, 32_768, 'target');
      return input.map(entry => visit(entry, depth + 1));
    }
    requireDataRecord(input, 'target');
    return Object.fromEntries(Object.entries(input).map(([key, entry]) => {
      bytes += Buffer.byteLength(key);
      if (bytes > 16 * 1024 * 1024) throw new ProfileError('limit-exceeded', 'target');
      return [key, visit(entry, depth + 1)];
    }));
  }
  return visit(value, 0);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The result contains local target data for the file writer, not for export or model messages.
export function previewConfiguration(
  value: unknown, target: unknown = {}, decisions: unknown = {},
): ConfigurationPreview {
  const profile: ResourceProfile = validateProfile(value);
  requireRecord(target, [], 'target', ['settings', 'keybindings', 'mcp']);
  const copied = copyTarget(target) as TargetConfiguration;
  for (const section of Object.values(copied)) requireDataRecord(section, 'target');
  const baseline = { settings: copied.settings ?? {}, keybindings: copied.keybindings ?? {}, mcp: copied.mcp ?? {} };
  const configuration = copyTarget(baseline) as Required<TargetConfiguration>;
  requireDataRecord(decisions, 'decisions');
  const choices = decisions;
  const items: PreviewItem[] = [];
  const known = new Set<string>();

  function offer(sectionName: keyof TargetConfiguration, path: string[], incoming: unknown, id: string): void {
    const section = configuration[sectionName];
    known.add(id);
    const decision = Object.hasOwn(choices, id) ? choices[id] : 'preserve';
    if (decision !== 'preserve' && decision !== 'overwrite') throw new ProfileError('invalid-content', 'decisions');
    let parent = baseline[sectionName];
    let blocked = false;
    for (const key of path.slice(0, -1)) {
      if (!Object.hasOwn(parent, key)) break;
      if (!record(parent[key])) { blocked = true; break; }
      parent = parent[key];
    }
    let existing: unknown = baseline[sectionName];
    let exists = true;
    for (const key of path) {
      if (!record(existing) || !Object.hasOwn(existing, key)) { exists = false; break; }
      existing = existing[key];
    }
    const status = blocked ? 'conflict' : !exists ? 'new' : isDeepStrictEqual(existing, incoming) ? 'same' : 'conflict';
    const write = status === 'new' || (status === 'conflict' && decision === 'overwrite');
    items.push({ id, status, action: write ? 'write' : 'preserve' });
    if (!write) return;
    parent = section;
    for (const key of path.slice(0, -1)) {
      if (!Object.hasOwn(parent, key) || !record(parent[key])) parent[key] = {};
      parent = parent[key] as Record<string, unknown>;
    }
    parent[path.at(-1) as string] = copyTarget(incoming);
  }

  function preferences(input: Record<string, unknown>, path: string[] = []): void {
    for (const [key, entry] of Object.entries(input)) {
      const next = [...path, key];
      if (record(entry)) preferences(entry, next);
      else offer('settings', next, entry, `preferences.${next.join('.')}`);
    }
  }
  if (profile.preferences) preferences(profile.preferences);
  for (const [key, entry] of Object.entries(profile.keybindings ?? {})) offer('keybindings', [key], entry, `keybindings.${key}`);
  for (const [key, entry] of Object.entries(profile.integrations?.subagents ?? {})) offer('settings', ['subagents', key], entry, `subagents.${key}`);
  for (const [name, server] of Object.entries(profile.integrations?.mcpServers ?? {})) {
    const { envNames, ...definition } = server;
    const native: Record<string, unknown> = { ...definition };
    if (envNames) native.env = Object.fromEntries(envNames.map(name => [name, `\${${name}}`]));
    offer('mcp', ['mcpServers', name], native, `mcpServers.${name}`);
  }
  if (Object.keys(decisions).some(key => !known.has(key))) throw new ProfileError('invalid-shape', 'decisions');
  return { items, configuration };
}
