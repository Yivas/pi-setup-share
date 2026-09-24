import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { homedir } from 'node:os';
import { exportResources, ResourceReadError, type ResourceSelection } from './files.ts';
import { previewProfileCategory, readGlobalCategory, selectGlobalCategory, type GlobalCategory } from './global-selection.ts';
import { activateImport, applyImport, inspectImport, installPackages, listImports, previewActivation, previewImport, previewInstallation, restoreImport, type PackageInstallerFactory } from './import.ts';
import { en } from './locales/en.ts';
import { readProfileFile, writeProfileFile } from './profile-file.ts';
import { discoverGlobalResources } from './resource-discovery.ts';
import { validateProfile, type ResourceKind, type ResourceProfile } from './profile.ts';
import { FileStore, StorageError } from './storage.ts';
import { TRANSFER_CATEGORIES, RECEIVER_ACTIONS, type TransferCategory, type TransferReason } from './transfer-report.ts';
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
  const lines = [en.profileWarning, en.selectedContents, `${en.resourceCount}: ${profile.resources.length}`, `${en.packageCount}: ${profile.packages?.length ?? 0}`];
  for (const resource of profile.resources) lines.push(`${resource.kind}: ${resource.path}`);
  for (const [kind, paths] of Object.entries(profile.entrypoints ?? {})) lines.push(`${en.entrypointCount} (${kind}): ${paths.join(', ')}`);
  for (const [category, entries] of Object.entries({ preferences: profile.preferences, keybindings: profile.keybindings,
    mcpServers: profile.integrations?.mcpServers, subagents: profile.integrations?.subagents })) {
    for (const [key, value] of Object.entries(entries ?? {})) lines.push(`${category}.${key}: ${JSON.stringify(value)}`);
  }
  for (const package_ of profile.packages ?? []) lines.push(JSON.stringify(package_));
  return lines.map(safeDisplay);
}

function transferSummary(profile: ResourceProfile, receiver: boolean): string[] {
  const report = profile.transfer;
  if (!report) return [];
  return [receiver ? en.reportClaimWarning : en.senderReport,
    `${en.transferScanned}: ${report.scanned.map(category => en.transferCategories[category]).join(', ') || en.none}`,
    `${en.transferPartial}: ${report.partial.map(category => en.transferCategories[category]).join(', ') || en.none}`,
    `${en.transferNotExamined}: ${report.notExamined.map(category => en.transferCategories[category]).join(', ') || en.none}`,
    ...report.omissions.map(item => `${en.transferCategories[item.category]}: ${item.count} ${en.transferReasons[item.reason]}`),
    ...report.actions.map(action => `${en.receiverAction}: ${en.receiverActions[action]}`),
  ].map(safeDisplay);
}

async function exportSetup(ctx: ExtensionCommandContext, store: FileStore, agentDir: string, homeDir: string): Promise<void> {
  await review(ctx, [en.exportWarning]);
  const categories = await selectItems(ctx, Object.entries(en.categories).map(([value, label]) => ({ value, label })));
  if (!categories) return;
  let profile = validateProfile({ format: 'pi-setup-share', version: 1, resources: [] });
  const diagnostics = new Map<string, number>();
  const omissions = new Map<string, { category: TransferCategory; reason: TransferReason; count: number }>();
  function addOmission(category: TransferCategory, reason: TransferReason, count: number): void {
    if (!count) return;
    const key = `${category}/${reason}`;
    const previous = omissions.get(key);
    omissions.set(key, { category, reason, count: Math.min(4096, (previous?.count ?? 0) + count) });
  }
  let scannedResources = false;
  let truncatedResources = false;
  for (const category of categories) {
    const preview = await readGlobalCategory(store, category as GlobalCategory);
    for (const diagnostic of preview.diagnostics) {
      const reason = `${en.categories[category as GlobalCategory]}: ${en.diagnosticReasons[diagnostic.code]}`;
      diagnostics.set(reason, (diagnostics.get(reason) ?? 0) + 1);
      if (diagnostic.code !== 'shared-key') addOmission(category as GlobalCategory, 'unsupported', 1);
    }
    if (category === 'mcpServers') {
      const omitted = [...new Set(preview.diagnostics
        .filter(diagnostic => diagnostic.code === 'unsupported-value' && diagnostic.label)
        .map(diagnostic => diagnostic.label as string))];
      if (omitted.length) await review(ctx, [en.omittedMcpTitle, ...omitted.map(label => `${label}: ${en.omittedMcpReason}`)]);
    }
    const ids = await selectItems(ctx, preview.items.map(({ id, label }) => ({ value: id, label })),
      category === 'mcpServers' ? en.selectAllPortableMcp : undefined);
    if (!ids) return;
    addOmission(category as GlobalCategory, 'unselected', preview.items.length - ids.length);
    const selected = selectGlobalCategory(preview, ids);
    profile = validateProfile({ ...profile, ...selected,
      ...(profile.integrations || selected.integrations ? { integrations: { ...profile.integrations, ...selected.integrations } } : {}),
    });
  }
  if (await ctx.ui.confirm(en.resourcesTitle, en.resourcesWarning)) {
    if (await ctx.ui.confirm(en.discoverTitle, en.discoverWarning)) {
      const inventory = await runOperation(ctx, en.reading, signal => discoverGlobalResources(agentDir, homeDir, signal));
      scannedResources = true;
      truncatedResources = inventory.truncated;
      const ids = await selectItems(ctx, inventory.items.map((item, index) => ({
        value: String(index), label: `${item.origin} · ${item.candidate.path}${item.candidate.entrypoint ? ` (${en.entrypointCount})` : ''}`,
      })));
      if (!ids) return;
      const selected = inventory.items.filter((_item, index) => ids.includes(String(index)));
      for (const { candidate } of inventory.items.filter((_item, index) => !ids.includes(String(index)))) {
        addOmission(candidate.kind, 'unselected', 1);
      }
      addOmission('resourceFiles', 'excluded', inventory.omitted);
      const unique = new Map<string, typeof selected[number]>();
      const omittedCollisions = new Set<string>();
      for (const item of selected) {
        const key = `${item.candidate.kind}/${item.candidate.path}`.toLowerCase().toUpperCase().normalize('NFC');
        if (omittedCollisions.has(key)) { addOmission(item.candidate.kind, 'collision', 1); continue; }
        const prior = unique.get(key);
        if (prior) {
          addOmission(item.candidate.kind, 'collision', 1);
          const origin = await ctx.ui.select(en.duplicateResource, [prior.origin, item.origin, en.skipCollision]);
          if (!origin) return;
          if (origin === en.skipCollision) {
            // Include neither source: both candidates are omitted and nothing replaces them.
            omittedCollisions.add(key);
            addOmission(item.candidate.kind, 'unselected', 2);
            unique.delete(key);
          } else if (origin === item.origin) unique.set(key, item);
        } else unique.set(key, item);
      }
      const chosen = [...unique.values()];
      const resources = [...profile.resources];
      const entrypoints: Partial<Record<ResourceKind, string[]>> = { ...profile.entrypoints };
      for (const root of new Set(chosen.map(item => item.root))) {
        const group = chosen.filter(item => item.root === root);
        resources.push(...await exportResources(root, group.map(({ candidate }) => ({ kind: candidate.kind, path: candidate.path }))));
        for (const { candidate } of group.filter(item => item.candidate.entrypoint)) {
          if (await ctx.ui.confirm(en.resourceEntry, `${candidate.kind}: ${safeDisplay(candidate.path)} — ${en.resourceEntryWarning}`)) {
            const paths = entrypoints[candidate.kind] ?? [];
            paths.push(candidate.path);
            entrypoints[candidate.kind] = paths;
          }
        }
      }
      profile = validateProfile({ ...profile, resources, entrypoints });
      diagnostics.set(en.omittedResources, inventory.omitted);
      if (inventory.truncated) await review(ctx, [en.inventoryTruncated]);
    }
    if (await ctx.ui.confirm(en.addManualTitle, en.resourcesWarning)) {
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
      profile = validateProfile({ ...profile, resources: [...profile.resources, ...resources],
        entrypoints: { ...profile.entrypoints, ...Object.fromEntries(Object.entries(entrypoints).map(([kind, paths]) => [kind,
          [...(profile.entrypoints?.[kind as ResourceKind] ?? []), ...paths],
        ])) },
      });
    }
  }
  const resourceKinds: TransferCategory[] = ['extension', 'skill', 'prompt', 'theme', 'agent', 'resourceFiles'];
  const partial = truncatedResources ? resourceKinds : [];
  const scanned = [...categories as TransferCategory[], ...(scannedResources && !truncatedResources ? resourceKinds : [])];
  const notExamined = TRANSFER_CATEGORIES.filter(category => !scanned.includes(category) && !partial.includes(category));
  // Every receiver action is always listed: the sender cannot prove that installing tools, verifying
  // endpoints or checking the platform is unnecessary for a given profile, and under-informing is worse.
  // The `limit` reason stays unused on purpose: truncation has no countable remainder, and `partial`
  // plus the explicit review line already report it without inventing a count.
  profile = validateProfile({ ...profile, version: 2, transfer: {
    scanned, partial, notExamined, omissions: [...omissions.values()], actions: [...RECEIVER_ACTIONS],
  } });
  await review(ctx, [...[...diagnostics].map(([reason, count]) => `${reason}: ${count}`), ...transferSummary(profile, false)]);
  await review(ctx, profileSummary(profile));
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
    const ids = await selectItems(ctx, preview.items.map(item => ({ value: item.id, label: `${category}.${item.label}` })),
      category === 'mcpServers' ? en.selectAllPortableMcp : undefined);
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
  return validateProfile({ ...selected, version: input.version, ...(input.transfer ? { transfer: input.transfer } : {}) });
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
    const choice = await ctx.ui.select(en.conflicts, [en.preserve, en.overwrite, en.skip, en.later]);
    if (!choice || choice === en.later) { ctx.ui.notify(en.deferred, 'info'); return; }
    (item.id.startsWith('resources.') || item.id.startsWith('packages:') ? resources : configuration)[item.id] =
      choice === en.overwrite ? 'overwrite' : choice === en.skip ? 'skip' : 'preserve';
  }
  activation = await previewActivation(store, importId, { configuration, resources });
  await review(ctx, activation.items.map(item => `${item.id}: ${item.status} / ${item.action}`));
  if (!await confirmStep(ctx, en.activateTitle, en.activateWarning)) { ctx.ui.notify(en.deferred, 'info'); return; }
  await runOperation(ctx, en.working, signal => activateImport(store, activation, true, signal));
  ctx.ui.notify(en.active, 'info');
}

export async function runSetupShare(ctx: ExtensionCommandContext, agentDir: string, installer: PackageInstallerFactory, homeDir = homedir()): Promise<void> {
  if (ctx.mode !== 'tui' || !ctx.hasUI) return;
  try {
    await runSetupShareFlow(ctx, agentDir, installer, homeDir);
  } catch (error) {
    // Boundary: recoverable failures become a notification, but cancellation, lock and recovery gates
    // must still reject so Pi and callers keep their cancellation and blocking contract.
    if (error instanceof StorageError) {
      if (error.code === 'aborted' || error.code === 'busy' || error.code === 'recovery-required') throw error;
      ctx.ui.notify(en.errors[error.code] ?? en.unknownError, 'warning');
      return;
    }
    if (error instanceof ProfileError) { ctx.ui.notify(en.invalidProfile, 'warning'); return; }
    throw error;
  }
}

async function runSetupShareFlow(ctx: ExtensionCommandContext, agentDir: string, installer: PackageInstallerFactory, homeDir: string): Promise<void> {
  const action = await ctx.ui.select(en.menu, [en.export, en.inspect, en.import, en.resume, en.restore, en.recover]);
  if (!action) return;
  if (action === en.inspect || action === en.import) {
    const path = await ctx.ui.input(en.source);
    if (!path) return;
    const original = await readProfileFile(path);
    if (action === en.inspect) {
      if (original.transfer) await review(ctx, transferSummary(original, true));
      await review(ctx, profileSummary(original));
      return;
    }
    const profile = await selectImportProfile(ctx, original);
    if (!profile) return;
    if (original.transfer) await review(ctx, transferSummary(original, true));
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
  if (action === en.export) { await exportSetup(ctx, store, agentDir, homeDir); return; }
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
