import { randomUUID } from 'node:crypto';
import { lstat, mkdir, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  installationTransactionId?: string;
  installationReceipt?: { packageSources: string[] };
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
export interface InstallationPlan {
  readonly kind: 'installation';
  readonly importId: string;
  readonly sources: readonly string[];
}
export interface PackageInstaller {
  install(source: string): Promise<void>;
  getInstalledPath(source: string, scope: 'user'): string | undefined;
}
export type PackageInstallerFactory = (packageStore: string) => PackageInstaller | Promise<PackageInstaller>;
export interface ImportResult { importId: string; state: 'staged' | 'active' }
interface PreparedPlan {
  store: FileStore;
  changes: FileChange[];
  transactionId: ReturnType<typeof randomUUID>;
  profileText: string;
  guards: { path: string; before: FileSnapshot }[];
  packageSources?: string[];
}
interface PreparedInstallation {
  store: FileStore;
  profileText: string;
  manifest: ImportManifest;
  manifestSnapshot: FileSnapshot;
  profileSnapshot: FileSnapshot;
}
const installationPlans = new WeakMap<object, PreparedInstallation>();
const stagingPlans = new WeakMap<object, PreparedPlan>();
const activationPlans = new WeakMap<object, PreparedPlan>();
const manifestLimit = 256 * 1024;
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
  requireRecord(value, ['format', 'version', 'importId', 'profileHash', 'state', 'stageTransactionId'], 'manifest', ['activationTransactionId', 'installationTransactionId', 'installationReceipt']);
  if (value.format !== 'pi-setup-share-import' || value.version !== 1 || value.importId !== importId
      || value.stageTransactionId !== importId || typeof value.profileHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.profileHash)
      || (value.state !== 'staged' && value.state !== 'active')) throw new StorageError('invalid-state');
  if (value.state === 'active' ? typeof value.activationTransactionId !== 'string' || !isImportId(value.activationTransactionId)
      || value.activationTransactionId === importId : Object.hasOwn(value, 'activationTransactionId')) throw new StorageError('invalid-state');
  const installed = Object.hasOwn(value, 'installationTransactionId');
  if (installed !== Object.hasOwn(value, 'installationReceipt')) throw new StorageError('invalid-state');
  if (installed) {
    if (typeof value.installationTransactionId !== 'string' || !isImportId(value.installationTransactionId)
        || value.installationTransactionId === importId || value.installationTransactionId === value.activationTransactionId) throw new StorageError('invalid-state');
    requireRecord(value.installationReceipt, ['packageSources'], 'manifest');
    const sources = value.installationReceipt.packageSources;
    if (!Array.isArray(sources) || !sources.length || sources.length > 64 || new Set(sources).size !== sources.length) throw new StorageError('invalid-state');
    for (const source of sources) validatePackageSource(source, importId);
  }
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
  if (plan.kind === 'activation') {
    await verifyAgentFiles(store, profile, plan.importId);
    for (const source of prepared.packageSources ?? []) await verifyPackageDirectory(store, plan.importId, source);
  }
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
  const latest = manifest.activationTransactionId ?? manifest.installationTransactionId ?? manifest.stageTransactionId;
  const applied = await appliedTransactionsFor(store, `${base}/manifest.json`, { id: latest, hash: manifestSnapshot.hash });
  const expected = [manifest.stageTransactionId, ...manifestTransactions(manifest)];
  if (applied.length !== expected.length || applied.some(id => !expected.includes(id))) throw new StorageError('changed');
  const profileSnapshot = await store.read(`${base}/profile.json`, PROFILE_LIMITS.jsonBytes);
  if (!profileSnapshot.bytes || profileSnapshot.hash !== manifest.profileHash) throw new StorageError('changed');
  const profile = parseProfile(profileSnapshot.bytes.toString('utf8'));
  if (manifest.installationReceipt && manifest.installationReceipt.packageSources.length !== profile.packages?.length) throw new StorageError('invalid-state');
  return { manifest, profile, manifestSnapshot, profileSnapshot };
}

function manifestTransactions(manifest: ImportManifest): string[] {
  return [manifest.installationTransactionId, manifest.activationTransactionId].filter((id): id is string => id !== undefined);
}
function validatePackageSource(source: unknown, importId: string): asserts source is string {
  if (typeof source !== 'string' || !source.startsWith(`./${basePath(importId)}/package-store/`)
      || Buffer.byteLength(source) > 2048 || source !== source.normalize('NFC') || /[\p{C}<>:"\\|?*]/u.test(source)
      || source.slice(2).split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new StorageError('unsafe-path');
}
function contained(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
}
async function verifyPackageDirectory(store: FileStore, importId: string, source: string): Promise<string> {
  validatePackageSource(source, importId);
  let path = store.root;
  try {
    for (const part of source.slice(2).split('/')) {
      path = join(path, part);
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageError('unsafe-path');
    }
    const canonical = await realpath(path);
    if (!contained(join(store.root, basePath(importId), 'package-store'), canonical)) throw new StorageError('unsafe-path');
    return canonical;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('unavailable');
  }
}
async function requireUnusedPackageStore(store: FileStore, importId: string): Promise<void> {
  try {
    const stat = await lstat(join(store.root, basePath(importId), 'package-store'));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageError('unsafe-path');
    throw new StorageError('installation-abandoned');
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new StorageError('unavailable');
  }
}
export async function previewInstallation(store: FileStore, importId: string): Promise<InstallationPlan> {
  await checkRecovery(store);
  const { manifest, profile, manifestSnapshot, profileSnapshot } = await readImport(store, importId);
  if (manifest.state !== 'staged' || manifest.installationReceipt || !profile.packages?.length) throw new StorageError('invalid-state');
  await requireUnusedPackageStore(store, importId);
  const plan: InstallationPlan = Object.freeze({ kind: 'installation', importId, sources: Object.freeze(profile.packages.map(package_ => package_.source)) });
  installationPlans.set(plan, { store, manifest, manifestSnapshot, profileSnapshot, profileText: serializeProfile(profile) });
  return plan;
}
export async function installPackages(store: FileStore, plan: InstallationPlan, consent: boolean, factory: PackageInstallerFactory, signal?: AbortSignal): Promise<ImportResult> {
  checkConsent(consent, signal);
  const prepared = installationPlans.get(plan);
  if (!prepared || prepared.store !== store) throw new StorageError('invalid-state');
  installationPlans.delete(plan);
  const base = basePath(plan.importId);
  await checkRecovery(store);
  await readImport(store, plan.importId);
  if (!await store.matches(`${base}/manifest.json`, prepared.manifestSnapshot) || !await store.matches(`${base}/profile.json`, prepared.profileSnapshot)) throw new StorageError('changed');
  await requireUnusedPackageStore(store, plan.importId);
  const packageStore = join(store.root, base, 'package-store');
  try {
    await mkdir(packageStore, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new StorageError('installation-abandoned');
    throw new StorageError('unavailable');
  }
  // The directory is a permanent attempt marker, not a sandbox or a rollback target.
  try {
    checkConsent(consent, signal);
    const installer = await factory(packageStore);
    const profile = parseProfile(prepared.profileText);
    const packageSources: string[] = [];
    for (const package_ of profile.packages ?? []) {
      checkConsent(consent, signal);
      await installer.install(package_.source);
      checkConsent(consent, signal);
      const installedPath = installer.getInstalledPath(package_.source, 'user');
      if (typeof installedPath !== 'string' || !isAbsolute(installedPath) || !contained(packageStore, resolve(installedPath))) throw new StorageError('unsafe-path');
      const source = `./${relative(store.root, resolve(installedPath)).replaceAll('\\', '/')}`;
      const canonical = await verifyPackageDirectory(store, plan.importId, source);
      packageSources.push(`./${relative(store.root, canonical).replaceAll('\\', '/')}`);
    }
    if (new Set(packageSources).size !== packageSources.length) throw new StorageError('unsafe-path');
    checkConsent(consent, signal);
    await readImport(store, plan.importId);
    for (const source of packageSources) await verifyPackageDirectory(store, plan.importId, source);
    if (!await store.matches(`${base}/profile.json`, prepared.profileSnapshot)) throw new StorageError('changed');
    const transactionId = randomUUID();
    const manifest: ImportManifest = { ...prepared.manifest, installationTransactionId: transactionId, installationReceipt: { packageSources } };
    await commitChanges(store, [{ path: `${base}/manifest.json`, bytes: jsonBytes(manifest, manifestLimit), before: prepared.manifestSnapshot }], true, signal, transactionId);
    return { importId: plan.importId, state: 'staged' };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('installation-abandoned');
  }
}

function addReferences(profile: ResourceProfile, importId: string, settings: Record<string, unknown>, decisions: Record<string, unknown>, packageSources: readonly string[]): PreviewItem[] {
  const items: PreviewItem[] = [];
  const known = new Set<string>();
  const baseline = { ...settings };
  const base = `./${basePath(importId)}`;
  function append(key: string, incoming: unknown[], id: string): void {
    if (!incoming.length) return;
    known.add(id);
    const decision = Object.hasOwn(decisions, id) ? decisions[id] : 'preserve';
    if (decision !== 'preserve' && decision !== 'overwrite') throw new StorageError('invalid-state');
    const existing = baseline[key];
    const valid = Array.isArray(existing) && (key === 'packages' || existing.every(entry => typeof entry === 'string'));
    const missing = !Object.hasOwn(baseline, key);
    const same = valid && incoming.every(entry => existing.some(current => isDeepStrictEqual(current, entry)));
    const status = missing ? 'new' : !valid ? 'conflict' : same ? 'same' : 'new';
    const write = status === 'new' || (status === 'conflict' && decision === 'overwrite');
    items.push({ id, status, action: write ? 'write' : 'preserve' });
    if (write) {
      const current: unknown[] = Array.isArray(settings[key]) ? settings[key] : [];
      settings[key] = [...current, ...incoming.filter(entry => !current.some(value => isDeepStrictEqual(value, entry)))];
    }
  }
  for (const [kind, setting] of [['extension', 'extensions'], ['skill', 'skills'], ['prompt', 'prompts'], ['theme', 'themes']] as const) {
    append(setting, (profile.entrypoints?.[kind] ?? []).map(path => `${base}/resources/${kind}/${path}`), `resources.${kind}`);
  }
  if (agentDirectories(profile).length) append('packages', [{ source: `${base}/agents-package`, extensions: [], skills: [], prompts: [], themes: [] }], 'resources.agent');
  if (packageSources.length) append('packages', (profile.packages ?? []).map((package_, index) => ({ ...package_, source: packageSources[index] })), 'packages');
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
  const packageSources = manifest.installationReceipt?.packageSources ?? [];
  for (const source of packageSources) await verifyPackageDirectory(store, importId, source);
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
  const items = [...preview.items, ...addReferences(profile, importId, preview.configuration.settings, resourceDecisions, packageSources)];
  const changes: FileChange[] = [];
  for (const section of ['settings', 'keybindings', 'mcp'] as const) {
    const before = snapshots.get(section) as FileSnapshot;
    guards.push({ path: configPaths[section], before });
    if (!isDeepStrictEqual(target[section], preview.configuration[section])) changes.push({ path: configPaths[section], bytes: jsonBytes(preview.configuration[section], configurationLimit), before });
  }
  const transactionId = randomUUID();
  const active: ImportManifest = { ...manifest, state: 'active', activationTransactionId: transactionId };
  changes.push({ path: `${basePath(importId)}/manifest.json`, bytes: jsonBytes(active, manifestLimit), before: manifestSnapshot });
  const plan: ActivationPlan = Object.freeze({ kind: 'activation', importId, items: Object.freeze(items.map(item => Object.freeze(item))), deferredPackages: manifest.installationReceipt ? 0 : profile.packages?.length ?? 0 });
  activationPlans.set(plan, { store, changes, transactionId, profileText: profileSnapshot.bytes?.toString('utf8') as string, guards, packageSources });
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
  await restoreChain(store, [...manifestTransactions(manifest).reverse(), manifest.stageTransactionId], true);
}
