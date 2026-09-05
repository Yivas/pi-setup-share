import { stringifyBounded } from './json.ts';
import { projectMcpServers, projectSubagents } from './integrations.ts';
import { projectKeybindings } from './keybindings.ts';
import { projectPackages } from './packages.ts';
import { projectPreferences } from './preferences.ts';
import { PROFILE_LIMITS, validateProfile, type ResourceProfile } from './profile.ts';
import { requireRecord, type ProjectionDiagnostic } from './validation.ts';

export interface ExportResult {
  profile: ResourceProfile;
  text: string;
  diagnostics: ProjectionDiagnostic[];
}

export function serializeProfile(value: unknown): string {
  return stringifyBounded(validateProfile(value), PROFILE_LIMITS.jsonBytes);
}

// Only the caller's explicit selections enter this function; it performs no discovery or I/O.
export function exportProfile(selection: unknown): ExportResult {
  requireRecord(selection, [], 'selection', ['resources', 'entrypoints', 'preferences', 'keybindings', 'mcpServers', 'subagents', 'packages']);
  const initial: Record<string, unknown> = { format: 'pi-setup-share', version: 1, resources: Object.hasOwn(selection, 'resources') ? selection.resources : [] };
  if (Object.hasOwn(selection, 'entrypoints')) initial.entrypoints = selection.entrypoints;
  const profile = validateProfile(initial);
  const diagnostics: ProjectionDiagnostic[] = [];
  if (Object.hasOwn(selection, 'preferences')) {
    const result = projectPreferences(selection.preferences);
    profile.preferences = result.value;
    diagnostics.push(...result.diagnostics);
  }
  if (Object.hasOwn(selection, 'keybindings')) {
    const result = projectKeybindings(selection.keybindings);
    profile.keybindings = result.value;
    diagnostics.push(...result.diagnostics);
  }
  if (Object.hasOwn(selection, 'mcpServers')) {
    const result = projectMcpServers(selection.mcpServers);
    profile.integrations = { mcpServers: result.value };
    diagnostics.push(...result.diagnostics);
  }
  if (Object.hasOwn(selection, 'subagents')) {
    const result = projectSubagents(selection.subagents);
    profile.integrations ??= {};
    profile.integrations.subagents = result.value;
    diagnostics.push(...result.diagnostics);
  }
  if (Object.hasOwn(selection, 'packages')) {
    const result = projectPackages(selection.packages);
    profile.packages = result.value;
    diagnostics.push(...result.diagnostics);
  }
  return { profile, text: serializeProfile(profile), diagnostics };
}
