import { isIP } from 'node:net';
import { validatePreferences } from './preferences.ts';
import { ProfileError, requireDataArray, requireDataRecord, requireRecord, type ProjectionDiagnostic, type ProjectionResult } from './validation.ts';

export interface PortableMcpServer {
  disabled: true;
  approveTools: true;
  command?: string;
  args?: string[];
  url?: string;
  envNames?: string[];
  includeTools?: string[];
  excludeTools?: string[];
  requestTimeoutMs?: number;
}
export type PortableSubagents = Record<string, string | boolean>;
export interface PortableIntegrations {
  mcpServers?: Record<string, PortableMcpServer>;
  subagents?: PortableSubagents;
}

function text(value: unknown, pattern: RegExp, max: number, field: string): string {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) throw new ProfileError('invalid-content', field);
  return value;
}

// Syntactic exclusion only: no DNS, requests, or claim that an endpoint is public.
export function validateHttpsUrl(value: unknown, field: string): string {
  const input = text(value, /^https:\/\/[^\s\p{C}]+$/u, 1024, field);
  let url: URL;
  try { url = new URL(input); } catch { throw new ProfileError('invalid-content', field); }
  const host = url.hostname.toLowerCase();
  if (url.username || url.password || url.search || url.hash || url.port || /[\\?#]/.test(input)
      || /^https:\/\/[^/]*@/.test(input)
      || isIP(host) || host.startsWith('[') || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)
      || /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|corp|home|arpa|test|invalid|example|onion)$/.test(host)) {
    throw new ProfileError('invalid-content', field);
  }
  return input;
}

function strings(value: unknown, pattern: RegExp, max: number, field: string): string[] {
  requireDataArray(value, 64, field);
  const result = value.map(entry => text(entry, pattern, max, field));
  if (new Set(result).size !== result.length) throw new ProfileError('invalid-content', field);
  return result;
}

const mcpFields = ['disabled', 'approveTools', 'command', 'args', 'url', 'envNames', 'includeTools', 'excludeTools', 'requestTimeoutMs'];

function mcpServer(value: unknown, field: string): PortableMcpServer {
  requireRecord(value, ['disabled', 'approveTools'], field, mcpFields.slice(2));
  if (value.disabled !== true || value.approveTools !== true || Object.hasOwn(value, 'command') === Object.hasOwn(value, 'url')) {
    throw new ProfileError('invalid-content', field);
  }
  const output: PortableMcpServer = { disabled: true, approveTools: true };
  if (Object.hasOwn(value, 'command')) output.command = text(value.command, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 128, `${field}.command`);
  if (Object.hasOwn(value, 'url')) output.url = validateHttpsUrl(value.url, `${field}.url`);
  if (Object.hasOwn(value, 'args')) {
    if (!output.command) throw new ProfileError('invalid-content', `${field}.args`);
    requireDataArray(value.args, 64, `${field}.args`);
    output.args = value.args.map(arg => {
      const argument = text(arg, /^[^\p{C}]*$/u, 1024, `${field}.args`);
      if (/(?:password|secret|token|authorization|api[-_]key)/i.test(argument)
          || /(?:^|[=:\s]|^-[a-zA-Z])["']?(?:[a-z]:[\\/]|[\\/]|~[\\/])/i.test(argument)
          || argument.includes('://')) throw new ProfileError('invalid-content', `${field}.args`);
      return argument;
    });
  }
  if (Object.hasOwn(value, 'envNames')) {
    output.envNames = strings(value.envNames, /^[A-Za-z_][A-Za-z0-9_]*$/, 128, `${field}.envNames`);
    if (new Set(output.envNames.map(name => name.toUpperCase())).size !== output.envNames.length) {
      throw new ProfileError('invalid-content', `${field}.envNames`);
    }
  }
  for (const key of ['includeTools', 'excludeTools'] as const) {
    if (Object.hasOwn(value, key)) output[key] = strings(value[key], /^[a-zA-Z0-9_*?.:/-]+$/, 128, `${field}.${key}`);
  }
  if (Object.hasOwn(value, 'requestTimeoutMs')) {
    if (typeof value.requestTimeoutMs !== 'number' || !Number.isSafeInteger(value.requestTimeoutMs)
        || value.requestTimeoutMs < 1 || value.requestTimeoutMs > 600_000) throw new ProfileError('invalid-content', `${field}.requestTimeoutMs`);
    output.requestTimeoutMs = value.requestTimeoutMs;
  }
  return output;
}

export function projectMcpServers(selected: unknown): ProjectionResult<Record<string, PortableMcpServer>> {
  requireDataRecord(selected, 'mcpServers');
  if (Object.keys(selected).length > 64) throw new ProfileError('limit-exceeded', 'mcpServers');
  const value: Record<string, PortableMcpServer> = {};
  const diagnostics: ProjectionDiagnostic[] = [];
  let index = 0;
  for (const [name, input] of Object.entries(selected)) {
    const field = `mcpServers[${index++}]`;
    let safeLabel: string | undefined;
    try {
      safeLabel = text(name, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 64, field);
      requireDataRecord(input, field);
      const candidate: Record<string, unknown> = { disabled: true, approveTools: true };
      let position = 0;
      for (const key of Object.keys(input)) {
        const sourceField = `${field}[${position++}]`;
        if (key === 'disabled' || key === 'approveTools') continue;
        if (key === 'env') {
          requireDataRecord(input.env, `${field}.env`);
          candidate.envNames = Object.keys(input.env);
        } else if (mcpFields.slice(2).includes(key) && key !== 'envNames') candidate[key] = input[key];
        else diagnostics.push({ field: sourceField, code: 'omitted-field' });
      }
      value[name] = mcpServer(candidate, field);
    } catch (error) {
      if (!(error instanceof ProfileError)) throw error;
      diagnostics.push(safeLabel === undefined
        ? { field, code: 'unsupported-value' }
        : { field, code: 'unsupported-value', label: safeLabel });
    }
  }
  return { value, diagnostics };
}

function subagents(input: unknown, strict: boolean, diagnostics: ProjectionDiagnostic[]): PortableSubagents {
  requireDataRecord(input, 'subagents');
  const output: PortableSubagents = {};
  let index = 0;
  for (const [key, value] of Object.entries(input)) {
    const field = `subagents[${index++}]`;
    if (!['defaultModel', 'defaultThinking', 'disableThinking', 'disableBuiltins'].includes(key)) {
      if (strict) throw new ProfileError('invalid-shape', field);
      diagnostics.push({ field, code: 'omitted-field' });
      continue;
    }
    try {
      if (key === 'defaultModel') validatePreferences({ defaultModel: value });
      else if (key === 'defaultThinking') validatePreferences({ defaultThinkingLevel: value });
      else if (typeof value !== 'boolean') throw new ProfileError('invalid-content', field);
      output[key] = value as string | boolean;
    } catch (error) {
      if (!(error instanceof ProfileError)) throw error;
      if (strict) throw new ProfileError('invalid-content', field);
      diagnostics.push({ field, code: 'unsupported-value' });
    }
  }
  return output;
}

export function projectSubagents(selected: unknown): ProjectionResult<PortableSubagents> {
  const diagnostics: ProjectionDiagnostic[] = [];
  return { value: subagents(selected, false, diagnostics), diagnostics };
}

export function validateIntegrations(input: unknown): PortableIntegrations {
  requireRecord(input, [], 'integrations', ['mcpServers', 'subagents']);
  const result: PortableIntegrations = {};
  if (Object.hasOwn(input, 'mcpServers')) {
    requireDataRecord(input.mcpServers, 'mcpServers');
    if (Object.keys(input.mcpServers).length > 64) throw new ProfileError('limit-exceeded', 'mcpServers');
    result.mcpServers = {};
    let index = 0;
    for (const [name, server] of Object.entries(input.mcpServers)) {
      const field = `mcpServers[${index++}]`;
      text(name, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 64, field);
      result.mcpServers[name] = mcpServer(server, field);
    }
  }
  if (Object.hasOwn(input, 'subagents')) result.subagents = subagents(input.subagents, true, []);
  return result;
}
