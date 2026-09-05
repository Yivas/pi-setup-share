import { randomUUID } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { serializeProfile } from './export.ts';
import { parseBoundedJson, stringifyBounded } from './json.ts';
import { previewConfiguration, type PreviewItem, type TargetConfiguration } from './preview.ts';
import { parseProfile, PROFILE_LIMITS, validateProfile, type ResourceProfile } from './profile.ts';
import { digest, FileStore, StorageError, type FileSnapshot } from './storage.ts';
import { appliedTransactionsFor, commitChanges, isImportId, restoreChain, type FileChange } from './transaction.ts';
import { requireDataRecord, requireRecord } from './validation.ts';

interface ImportManifest {
  format: 'pi-setup-share-import';
  version: 1;
  importId: string;
  profileHash: string;
  state: 'staged' | 'active';
  stageTransactionId: string;
  activationTransactionId?: string;
}
export interface StagingPlan {
  readonly kind: 'staging';
  readonly importId: string;
  readonly resources: number;
  readonly entrypoints: number;
  readonly packages: number;
}
export interface ActivationPlan {
  readonly kind: 'activation';
  readonly importId: string;
  readonly items: readonly Readonly<PreviewItem>[];
  readonly deferredPackages: number;
}
export interface ImportResult { importId: string; state: 'staged' | 'active' }
interface PreparedPlan {
  store: FileStore;
  changes: FileChange[];
  transactionId: ReturnType<typeof randomUUID>;
  profileText: string;
  guards: { path: string; before: FileSnapshot }[];
}
const stagingPlans = new WeakMap<object, PreparedPlan>();
const activationPlans = new WeakMap<object, PreparedPlan>();
const manifestLimit = 4096;
const configurationLimit = 4 * 1024 * 1024;
const configPaths = { settings: 'settings.json', keybindings: 'keybindings.json', mcp: 'mcp.json' } as const;

function basePath(importId: string): string {
  if (!isImportId(importId)) throw new StorageError('invalid-state');
  return `setup-share/imports/${importId}`;
}
function jsonBytes(value: unknown, limit: number): Buffer { return Buffer.from(stringifyBounded(value, limit)); }
function checkConsent(consent: boolean, signal?: AbortSignal): void {
  if (consent !== true) throw new StorageError('consent-required');
  if (signal?.aborted) throw new StorageError('aborted');
}
async function checkRecovery(store: FileStore): Promise<void> {
  if ((await store.read('setup-share/pending.json', 8192)).bytes !== null) throw new StorageError('recovery-required');
}
function decodeManifest(bytes: Buffer | null, importId: string): ImportManifest {
  if (!bytes) throw new StorageError('invalid-state');
  const value = parseBoundedJson(bytes.toString('utf8'), manifestLimit);
  requireRecord(value, ['format', 'version', 'importId', 'profileHash', 'state', 'stageTransactionId'], 'manifest', ['activationTransactionId']);
  if (value.format !== 'pi-setup-share-import' || value.version !== 1 || value.importId !== importId
      || value.stageTransactionId !== importId || typeof value.profileHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.profileHash)
      || (value.state !== 'staged' && value.state !== 'active')) throw new StorageError('invalid-state');
  if (value.state === 'active' ? typeof value.activationTransactionId !== 'string' || !isImportId(value.activationTransactionId)
      || value.activationTransactionId === importId : Object.hasOwn(value, 'activationTransactionId')) throw new StorageError('invalid-state');
  return value as unknown as ImportManifest;
}

// Agent discovery is recursive by directory. Do not let support Markdown become an entrypoint.
function agentDirectories(profile: ResourceProfile): string[] {
  const entries = profile.entrypoints?.agent ?? [];
  const directories = [...new Set(entries.map(path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''))];
  return directories.filter(directory => !directories.some(parent => parent !== directory && (!parent || directory.startsWith(`${parent}/`))));
}
function validateAgentDiscovery(profile: ResourceProfile): void {
  const directories = agentDirectories(profile);
  const selected = new Set(profile.entrypoints?.agent ?? []);
  for (const resource of profile.resources) {
    if (resource.kind !== 'agent' || !resource.path.endsWith('.md') || resource.path.endsWith('.chain.md')) continue;
    if (!selected.has(resource.path) && directories.some(directory => !directory || resource.path.startsWith(`${directory}/`))) throw new StorageError('invalid-state');
  }
}
async function verifyAgentFiles(store: FileStore, profile: ResourceProfile, importId: string): Promise<void> {
  validateAgentDiscovery(profile);
  const selected = new Set(profile.entrypoints?.agent ?? []);
  let entries = 0;
  async function visit(relative: string): Promise<void> {
    const path = join(store.root, basePath(importId), 'agents-package', 'agents', relative);
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageError('unsafe-path');
      const directory = await opendir(path);
      for await (const entry of directory) {
        if (++entries > 1024) throw new StorageError('limit-exceeded');
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (Buffer.byteLength(child) > PROFILE_LIMITS.pathBytes) throw new StorageError('unsafe-path');
        if (entry.isDirectory()) await visit(child);
        else if (!entry.isFile()) throw new StorageError('unsafe-path');
        else if (child.endsWith('.md') && !child.endsWith('.chain.md') && !selected.has(child)) throw new StorageError('changed');
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError('unavailable');
    }
  }
  for (const directory of agentDirectories(profile)) await visit(directory);
}
function resourceFiles(profile: ResourceProfile, importId: string): { path: string; bytes: Buffer }[] {
  const base = basePath(importId);
  const files: { path: string; bytes: Buffer }[] = profile.resources.map(resource => ({
    path: resource.kind === 'agent' ? `${base}/agents-package/agents/${resource.path}` : `${base}/resources/${resource.kind}/${resource.path}`,
    bytes: Buffer.from(resource.content, resource.encoding === 'utf8' ? 'utf8' : 'base64'),
  }));
  const directories = agentDirectories(profile);
  if (directories.length) files.push({
    path: `${base}/agents-package/package.json`,
    bytes: jsonBytes({ private: true, pi: { extensions: [], skills: [], prompts: [], themes: [] }, 'pi-subagents': { agents: directories.map(directory => directory ? `./agents/${directory}` : './agents') } }, 64 * 1024),
  });
  return files;
}

export async function previewImport(store: FileStore, value: unknown): Promise<StagingPlan> {
  const profile = validateProfile(value);
  const profileText = serializeProfile(profile);
  await checkRecovery(store);
  const importId = randomUUID();
  const manifest: ImportManifest = { format: 'pi-setup-share-import', version: 1, importId, profileHash: digest(Buffer.from(profileText)), state: 'staged', stageTransactionId: importId };
  const files = [
    { path: `${basePath(importId)}/profile.json`, bytes: Buffer.from(profileText) },
    ...resourceFiles(profile, importId),
    { path: `${basePath(importId)}/manifest.json`, bytes: jsonBytes(manifest, manifestLimit) },
  ];
  const changes: FileChange[] = [];
  for (const file of files) {
    const before = await store.read(file.path, PROFILE_LIMITS.jsonBytes);
    if (before.bytes !== null) throw new StorageError('changed');
    changes.push({ ...file, before });
  }
  const plan: StagingPlan = Object.freeze({ kind: 'staging', importId, resources: profile.resources.length,
    entrypoints: Object.values(profile.entrypoints ?? {}).reduce((count, paths) => count + paths.length, 0), packages: profile.packages?.length ?? 0 });
  stagingPlans.set(plan, { store, changes, transactionId: importId, profileText, guards: [] });
  return plan;
}

async function executePlan(store: FileStore, plan: StagingPlan | ActivationPlan, plans: WeakMap<object, PreparedPlan>, consent: boolean, signal?: AbortSignal): Promise<void> {
  checkConsent(consent, signal);
  const prepared = plans.get(plan);
  if (!prepared || prepared.store !== store) throw new StorageError('invalid-state');
  plans.delete(plan);
  // Keep private snapshots and profile bytes out of the UI object, and revalidate before writing.
  const profile = parseProfile(prepared.profileText);
  for (const guard of prepared.guards) if (!await store.matches(guard.path, guard.before)) throw new StorageError('changed');
  if (plan.kind === 'activation') await verifyAgentFiles(store, profile, plan.importId);
  const id = await commitChanges(store, prepared.changes, true, signal, prepared.transactionId);
  if (id !== prepared.transactionId) throw new StorageError('invalid-state');
}
export async function applyImport(store: FileStore, plan: StagingPlan, consent: boolean, signal?: AbortSignal): Promise<ImportResult> {
  await executePlan(store, plan, stagingPlans, consent, signal);
  return { importId: plan.importId, state: 'staged' };
}

async function readImport(store: FileStore, importId: string): Promise<{ manifest: ImportManifest; profile: ResourceProfile; manifestSnapshot: FileSnapshot; profileSnapshot: FileSnapshot }> {
  const base = basePath(importId);
  const manifestSnapshot = await store.read(`${base}/manifest.json`, manifestLimit);
  const manifest = decodeManifest(manifestSnapshot.bytes, importId);
  const applied = await appliedTransactionsFor(store, `${base}/manifest.json`);
  const expected = [manifest.stageTransactionId, ...(manifest.activationTransactionId ? [manifest.activationTransactionId] : [])];
  if (applied.length !== expected.length || applied.some(id => !expected.includes(id))) throw new StorageError('changed');
  const profileSnapshot = await store.read(`${base}/profile.json`, PROFILE_LIMITS.jsonBytes);
  if (!profileSnapshot.bytes || profileSnapshot.hash !== manifest.profileHash) throw new StorageError('changed');
  const profile = parseProfile(profileSnapshot.bytes.toString('utf8'));
  return { manifest, profile, manifestSnapshot, profileSnapshot };
}

function addReferences(profile: ResourceProfile, importId: string, settings: Record<string, unknown>, decisions: Record<string, unknown>): PreviewItem[] {
  const items: PreviewItem[] = [];
  const known = new Set<string>();
  const base = `./${basePath(importId)}`;
  function append(key: string, incoming: unknown[], id: string): void {
    if (!incoming.length) return;
    known.add(id);
    const decision = Object.hasOwn(decisions, id) ? decisions[id] : 'preserve';
    if (decision !== 'preserve' && decision !== 'overwrite') throw new StorageError('invalid-state');
    const existing = settings[key];
    const valid = Array.isArray(existing) && (key === 'packages' || existing.every(entry => typeof entry === 'string'));
    const missing = !Object.hasOwn(settings, key);
    const same = valid && incoming.every(entry => existing.some(current => isDeepStrictEqual(current, entry)));
    const status = missing ? 'new' : !valid ? 'conflict' : same ? 'same' : 'new';
    const write = status === 'new' || (status === 'conflict' && decision === 'overwrite');
    items.push({ id, status, action: write ? 'write' : 'preserve' });
    if (write) settings[key] = [...(valid ? existing : []), ...incoming.filter(entry => !valid || !existing.some(current => isDeepStrictEqual(current, entry)))];
  }
  for (const [kind, setting] of [['extension', 'extensions'], ['skill', 'skills'], ['prompt', 'prompts'], ['theme', 'themes']] as const) {
    append(setting, (profile.entrypoints?.[kind] ?? []).map(path => `${base}/resources/${kind}/${path}`), `resources.${kind}`);
  }
  if (agentDirectories(profile).length) append('packages', [{ source: `${base}/agents-package`, extensions: [], skills: [], prompts: [], themes: [] }], 'resources.agent');
  if (Object.keys(decisions).some(key => !known.has(key))) throw new StorageError('invalid-state');
  return items;
}

export async function previewActivation(store: FileStore, importId: string, decisions: unknown = {}): Promise<ActivationPlan> {
  requireRecord(decisions, [], 'decisions', ['configuration', 'resources']);
  const configurationDecisions = Object.hasOwn(decisions, 'configuration') ? decisions.configuration : {};
  const resourceDecisions = Object.hasOwn(decisions, 'resources') ? decisions.resources : {};
  requireDataRecord(resourceDecisions, 'decisions');
  await checkRecovery(store);
  const { manifest, profile, manifestSnapshot, profileSnapshot } = await readImport(store, importId);
  if (manifest.state !== 'staged') throw new StorageError('invalid-state');
  validateAgentDiscovery(profile);
  const guards = [{ path: `${basePath(importId)}/profile.json`, before: profileSnapshot }];
  for (const file of resourceFiles(profile, importId)) {
    const before = await store.read(file.path, PROFILE_LIMITS.jsonBytes);
    if (before.hash !== digest(file.bytes)) throw new StorageError('changed');
    guards.push({ path: file.path, before });
  }
  await verifyAgentFiles(store, profile, importId);
  const target: TargetConfiguration = {};
  const snapshots = new Map<keyof TargetConfiguration, FileSnapshot>();
  for (const section of ['settings', 'keybindings', 'mcp'] as const) {
    const before = await store.read(configPaths[section], configurationLimit);
    snapshots.set(section, before);
    const value = before.bytes === null ? {} : parseBoundedJson(before.bytes.toString('utf8'), configurationLimit);
    requireDataRecord(value, 'target');
    target[section] = value;
  }
  const preview = previewConfiguration(profile, target, configurationDecisions);
  const items = [...preview.items, ...addReferences(profile, importId, preview.configuration.settings, resourceDecisions)];
  const changes: FileChange[] = [];
  for (const section of ['settings', 'keybindings', 'mcp'] as const) {
    const before = snapshots.get(section) as FileSnapshot;
    guards.push({ path: configPaths[section], before });
    if (!isDeepStrictEqual(target[section], preview.configuration[section])) changes.push({ path: configPaths[section], bytes: jsonBytes(preview.configuration[section], configurationLimit), before });
  }
  const transactionId = randomUUID();
  const active: ImportManifest = { ...manifest, state: 'active', activationTransactionId: transactionId };
  changes.push({ path: `${basePath(importId)}/manifest.json`, bytes: jsonBytes(active, manifestLimit), before: manifestSnapshot });
  const plan: ActivationPlan = Object.freeze({ kind: 'activation', importId, items: Object.freeze(items.map(item => Object.freeze(item))), deferredPackages: profile.packages?.length ?? 0 });
  activationPlans.set(plan, { store, changes, transactionId, profileText: profileSnapshot.bytes?.toString('utf8') as string, guards });
  return plan;
}
export async function activateImport(store: FileStore, plan: ActivationPlan, consent: boolean, signal?: AbortSignal): Promise<ImportResult> {
  await executePlan(store, plan, activationPlans, consent, signal);
  return { importId: plan.importId, state: 'active' };
}
export async function restoreImport(store: FileStore, importId: string, consent: boolean): Promise<void> {
  checkConsent(consent);
  await checkRecovery(store);
  const { manifest } = await readImport(store, importId);
  await restoreChain(store, manifest.activationTransactionId ? [manifest.activationTransactionId, manifest.stageTransactionId] : [manifest.stageTransactionId], true);
}
