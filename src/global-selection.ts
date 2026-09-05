import { isUtf8 } from 'node:buffer';
import { exportProfile } from './export.ts';
import { parseBoundedJson } from './json.ts';
import { validateProfile, type ResourceProfile } from './profile.ts';
import { type FileStore, StorageError } from './storage.ts';
import { requireDataRecord, type ProjectionDiagnostic } from './validation.ts';

export type GlobalCategory = 'preferences' | 'keybindings' | 'mcpServers' | 'subagents' | 'packages';
export interface GlobalCandidate {
  readonly id: string;
  readonly label: string;
  readonly path: readonly string[];
  readonly value: unknown;
}
export interface GlobalCategoryPreview {
  readonly category: GlobalCategory;
  readonly present: boolean;
  readonly items: readonly GlobalCandidate[];
  readonly diagnostics: readonly ProjectionDiagnostic[];
}
const files: Record<GlobalCategory, string> = { preferences: 'settings.json', keybindings: 'keybindings.json', mcpServers: 'mcp.json', subagents: 'settings.json', packages: 'settings.json' };

export async function readGlobalCategory(store: FileStore, category: GlobalCategory): Promise<GlobalCategoryPreview> {
  if (!Object.hasOwn(files, category)) throw new StorageError('invalid-state');
  const snapshot = await store.read(files[category]);
  if (snapshot.bytes && !isUtf8(snapshot.bytes)) throw new StorageError('invalid-state');
  const source = snapshot.bytes === null ? {} : parseBoundedJson(snapshot.bytes.toString('utf8'), 4 * 1024 * 1024);
  requireDataRecord(source, 'global');
  const nested = category === 'mcpServers' || category === 'subagents' || category === 'packages';
  const present = snapshot.bytes !== null && (!nested || Object.hasOwn(source, category));
  const input = nested ? (Object.hasOwn(source, category) ? source[category] : category === 'packages' ? [] : {}) : source;
  const result = exportProfile({ [category]: input });
  return previewProfileCategory(result.profile, category, present, result.diagnostics);
}

export function previewProfileCategory(profile: ResourceProfile, category: GlobalCategory, present = true, diagnostics: readonly ProjectionDiagnostic[] = []): GlobalCategoryPreview {
  const values = category === 'mcpServers' ? profile.integrations?.mcpServers
    : category === 'subagents' ? profile.integrations?.subagents : profile[category];
  const items: GlobalCandidate[] = [];
  function add(value: unknown, path: string[]): void {
    if (category === 'preferences' && value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) add(child, [...path, key]);
    } else {
      const label = category === 'packages' ? (value as { source: string }).source : path.join('.');
      items.push(Object.freeze({ id: String(items.length), label, path: Object.freeze(path), value: structuredClone(value) }));
    }
  }
  for (const [key, value] of Object.entries(values ?? {})) add(value, [key]);
  return Object.freeze({ category, present, items: Object.freeze(items), diagnostics: Object.freeze([...diagnostics]) });
}

export function selectGlobalCategory(preview: GlobalCategoryPreview, ids: readonly string[]): ResourceProfile {
  if (new Set(ids).size !== ids.length || ids.some(id => !preview.items.some(item => item.id === id))) throw new StorageError('invalid-state');
  const profile: Record<string, unknown> = { format: 'pi-setup-share', version: 1, resources: [] };
  if (!preview.present) return validateProfile(profile);
  const selected: Record<string, unknown> = Object.create(null);
  const packages: unknown[] = [];
  for (const item of preview.items.filter(item => ids.includes(item.id))) {
    if (preview.category === 'packages') { packages.push(structuredClone(item.value)); continue; }
    let parent = selected;
    for (const key of item.path.slice(0, -1)) {
      if (!Object.hasOwn(parent, key)) parent[key] = Object.create(null);
      parent = parent[key] as Record<string, unknown>;
    }
    parent[item.path.at(-1) as string] = structuredClone(item.value);
  }
  if (preview.category === 'mcpServers' || preview.category === 'subagents') profile.integrations = { [preview.category]: selected };
  else profile[preview.category] = preview.category === 'packages' ? packages : selected;
  return validateProfile(profile);
}
