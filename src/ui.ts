import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { exportResources, ResourceReadError, type ResourceSelection } from './files.ts';
import { previewProfileCategory, readGlobalCategory, selectGlobalCategory, type GlobalCategory } from './global-selection.ts';
import { activateImport, applyImport, inspectImport, installPackages, listImports, previewActivation, previewImport, previewInstallation, restoreImport, type PackageInstallerFactory } from './import.ts';
import { en } from './locales/en.ts';
import { readProfileFile, writeProfileFile } from './profile-file.ts';
import { validateProfile, type ResourceKind, type ResourceProfile } from './profile.ts';
import { FileStore, StorageError } from './storage.ts';
import { recoverChanges } from './transaction.ts';
import { confirmStep, review, runOperation, safeDisplay, selectItems } from './ui-components.ts';
import { ProfileError } from './validation.ts';

export function errorMessage(error: unknown): string {
  if (error instanceof StorageError) return en.errors[error.code];
  if (error instanceof ProfileError) return en.invalidProfile;
  if (error instanceof ResourceReadError) return error.code === 'not-file' || error.code === 'link' ? en.errors['unsafe-path'] : en.errors[error.code];
  return en.unknownError;
}

export function profileSummary(profile: ResourceProfile): string[] {
  const lines = [en.profileWarning, `${en.resourceCount}: ${profile.resources.length}`, `${en.packageCount}: ${profile.packages?.length ?? 0}`];
  for (const resource of profile.resources) lines.push(`${resource.kind}: ${resource.path}`);
  for (const [kind, paths] of Object.entries(profile.entrypoints ?? {})) lines.push(`${en.entrypointCount} (${kind}): ${paths.join(', ')}`);
  for (const [category, entries] of Object.entries({ preferences: profile.preferences, keybindings: profile.keybindings,
    mcpServers: profile.integrations?.mcpServers, subagents: profile.integrations?.subagents })) {
    for (const [key, value] of Object.entries(entries ?? {})) lines.push(`${category}.${key}: ${JSON.stringify(value)}`);
  }
  for (const package_ of profile.packages ?? []) lines.push(JSON.stringify(package_));
  return lines.map(safeDisplay);
}

async function exportSetup(ctx: ExtensionCommandContext, store: FileStore): Promise<void> {
  await review(ctx, [en.exportWarning]);
  const categories = await selectItems(ctx, Object.entries(en.categories).map(([value, label]) => ({ value, label })));
  if (!categories) return;
  let profile = validateProfile({ format: 'pi-setup-share', version: 1, resources: [] });
  const diagnostics = new Map<string, number>();
  for (const category of categories) {
    const preview = await readGlobalCategory(store, category as GlobalCategory);
    for (const diagnostic of preview.diagnostics) {
      const reason = `${en.categories[category as GlobalCategory]}: ${en.diagnosticReasons[diagnostic.code]}`;
      diagnostics.set(reason, (diagnostics.get(reason) ?? 0) + 1);
    }
    const ids = await selectItems(ctx, preview.items.map(({ id, label }) => ({ value: id, label })));
    if (!ids) return;
    const selected = selectGlobalCategory(preview, ids);
    profile = validateProfile({ ...profile, ...selected,
      ...(profile.integrations || selected.integrations ? { integrations: { ...profile.integrations, ...selected.integrations } } : {}),
    });
  }
  if (await ctx.ui.confirm(en.resourcesTitle, en.resourcesWarning)) {
    const root = await ctx.ui.input(en.resourceRoot);
    if (!root) return;
    const selections: ResourceSelection[] = [];
    const entrypoints: Partial<Record<ResourceKind, string[]>> = {};
    do {
      const label = await ctx.ui.select(en.resourceKind, Object.values(en.resourceKinds));
      if (!label) return;
      const kind = (Object.entries(en.resourceKinds).find(([, value]) => value === label)?.[0]) as ResourceKind;
      const path = await ctx.ui.input(en.resourcePath);
      if (!path) return;
      selections.push({ kind, path });
      if (await ctx.ui.confirm(en.resourceEntry, en.resourceEntryWarning)) {
        entrypoints[kind] ??= [];
        entrypoints[kind].push(path);
      }
    } while (selections.length < 256 && await ctx.ui.confirm(en.anotherResource, en.resourcesWarning));
    const resources = await exportResources(root, selections);
    profile = validateProfile({ ...profile, resources, entrypoints });
  }
  await review(ctx, [...profileSummary(profile), ...[...diagnostics].map(([reason, count]) => `${reason}: ${count}`)]);
  const path = await ctx.ui.input(en.destination);
  if (!path || !await confirmStep(ctx, en.saveTitle, en.saveWarning)) return;
  await runOperation(ctx, en.working, signal => writeProfileFile(path, profile, true, signal));
  ctx.ui.notify(en.saved, 'info');
}

async function selectImportProfile(ctx: ExtensionCommandContext, input: ResourceProfile): Promise<ResourceProfile | undefined> {
  let selected = validateProfile({ format: 'pi-setup-share', version: 1, resources: [] });
  for (const category of Object.keys(en.categories) as GlobalCategory[]) {
    const present = category === 'mcpServers' || category === 'subagents' ? Object.hasOwn(input.integrations ?? {}, category) : Object.hasOwn(input, category);
    if (!present) continue;
    const preview = previewProfileCategory(input, category);
    const ids = await selectItems(ctx, preview.items.map(item => ({ value: item.id, label: `${category}.${item.label}` })));
    if (!ids) return undefined;
    const fragment = selectGlobalCategory(preview, ids);
    selected = validateProfile({ ...selected, ...fragment,
      ...(selected.integrations || fragment.integrations ? { integrations: { ...selected.integrations, ...fragment.integrations } } : {}),
    });
  }
  if (input.resources.length) {
    const ids = await selectItems(ctx, input.resources.map((resource, index) => ({ value: String(index), label: `${resource.kind}: ${resource.path}` })));
    if (!ids) return undefined;
    selected.resources = input.resources.filter((_resource, index) => ids.includes(String(index)));
    if (input.entrypoints) selected.entrypoints = Object.fromEntries(Object.entries(input.entrypoints).map(([kind, paths]) => [kind,
      paths.filter(path => selected.resources.some(resource => resource.kind === kind && resource.path === path)),
    ]));
  }
  return validateProfile(selected);
}

async function continueImport(ctx: ExtensionCommandContext, store: FileStore, importId: string, installer: PackageInstallerFactory): Promise<void> {
  const status = await inspectImport(store, importId);
  if (status.state === 'active') { ctx.ui.notify(en.active, 'info'); return; }
  if (status.state === 'installation-abandoned') { ctx.ui.notify(en.abandoned, 'warning'); return; }
  if (status.state === 'staged' && status.packages) {
    const installation = await previewInstallation(store, importId);
    await review(ctx, installation.sources);
    if (!await confirmStep(ctx, en.installTitle, en.installWarning)) { ctx.ui.notify(en.deferred, 'info'); return; }
    await runOperation(ctx, en.installing, signal => installPackages(store, installation, true, installer, signal));
  }
  let activation = await previewActivation(store, importId);
  const configuration: Record<string, string> = {};
  const resources: Record<string, string> = {};
  for (const item of activation.items.filter(item => item.status === 'conflict')) {
    await review(ctx, [safeDisplay(item.id)]);
    const choice = await ctx.ui.select(en.conflicts, [en.preserve, en.overwrite, en.later]);
    if (!choice || choice === en.later) { ctx.ui.notify(en.deferred, 'info'); return; }
    (item.id.startsWith('resources.') || item.id === 'packages' ? resources : configuration)[item.id] = choice === en.overwrite ? 'overwrite' : 'preserve';
  }
  activation = await previewActivation(store, importId, { configuration, resources });
  await review(ctx, activation.items.map(item => `${item.id}: ${item.status} / ${item.action}`));
  if (!await confirmStep(ctx, en.activateTitle, en.activateWarning)) { ctx.ui.notify(en.deferred, 'info'); return; }
  await runOperation(ctx, en.working, signal => activateImport(store, activation, true, signal));
  ctx.ui.notify(en.active, 'info');
}

export async function runSetupShare(ctx: ExtensionCommandContext, agentDir: string, installer: PackageInstallerFactory): Promise<void> {
  if (ctx.mode !== 'tui' || !ctx.hasUI) return;
  const action = await ctx.ui.select(en.menu, [en.export, en.inspect, en.import, en.resume, en.restore, en.recover]);
  if (!action) return;
  if (action === en.inspect || action === en.import) {
    const path = await ctx.ui.input(en.source);
    if (!path) return;
    const original = await readProfileFile(path);
    if (action === en.inspect) { await review(ctx, profileSummary(original)); return; }
    const profile = await selectImportProfile(ctx, original);
    if (!profile) return;
    await review(ctx, profileSummary(profile));
    const store = await FileStore.open(agentDir);
    const staging = await previewImport(store, profile);
    if (!await confirmStep(ctx, en.stageTitle, en.stageWarning)) { ctx.ui.notify(en.noChanges, 'info'); return; }
    await runOperation(ctx, en.working, signal => applyImport(store, staging, true, signal));
    ctx.ui.notify(en.staged, 'info');
    await continueImport(ctx, store, staging.importId, installer);
    return;
  }
  const store = await FileStore.open(agentDir);
  if (action === en.export) { await exportSetup(ctx, store); return; }
  if (action === en.recover) {
    if (!await confirmStep(ctx, en.recoveryTitle, en.recoveryWarning)) return;
    const locked = await store.hasDirectory('setup-share/lock');
    if (locked && !await ctx.ui.confirm(en.staleLockTitle, en.staleLockWarning)) return;
    await recoverChanges(store, true, locked);
    ctx.ui.notify(en.recovered, 'info');
    return;
  }
  const ids = await listImports(store);
  if (!ids.length) { ctx.ui.notify(en.noImports, 'info'); return; }
  const entries = await runOperation(ctx, en.reading, async signal => {
    const results: { id: string; label: string }[] = [];
    for (const id of ids) {
      if (signal.aborted) throw new StorageError('aborted');
      try {
        const summary = await inspectImport(store, id);
        const next = summary.state === 'active' ? en.nextActions.restore
          : summary.state === 'installation-abandoned' ? en.nextActions.fresh
          : summary.state === 'staged' && summary.packages ? en.nextActions.install : en.nextActions.activate;
        results.push({ id, label: en.importLabel(id, en.states[summary.state], summary.resources, summary.packages, next) });
      } catch (error) {
        if (!(error instanceof StorageError) && !(error instanceof ProfileError)) throw error;
        if (error instanceof StorageError && (error.code === 'recovery-required' || error.code === 'limit-exceeded')) throw error;
        results.push({ id, label: en.unverifiedImport(id) });
      }
    }
    return results;
  });
  const selected = await ctx.ui.select(en.chooseImport, entries.map(entry => entry.label));
  const importId = entries.find(entry => entry.label === selected)?.id;
  if (!importId) return;
  if (action === en.restore) {
    if (!await confirmStep(ctx, en.restoreTitle, en.restoreWarning)) return;
    await restoreImport(store, importId, true);
    ctx.ui.notify(en.restored, 'info');
  } else await continueImport(ctx, store, importId, installer);
}
