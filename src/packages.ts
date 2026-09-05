import { validateHttpsUrl } from './integrations.ts';
import { ProfileError, requireDataArray, requireDataRecord, requireRecord, type ProjectionDiagnostic, type ProjectionResult } from './validation.ts';

const filters = ['extensions', 'skills', 'prompts', 'themes'] as const;
export interface PortablePackage {
  source: string;
  autoload?: boolean;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

function pinnedSource(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 1024) throw new ProfileError('invalid-content', field);
  const npm = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(value);
  if (npm && (npm[1]?.length ?? 0) <= 214) {
    if (npm[3]?.split('.').some(part => /^0\d+$/.test(part))) throw new ProfileError('invalid-content', field);
    return value;
  }
  const git = /^git:(.+)@([a-fA-F0-9]{40})$/.exec(value);
  if (!git) throw new ProfileError('invalid-content', field);
  const address = git[1] as string;
  if (/[\\%?#]/.test(address) || address.split('/').some(part => part === '.' || part === '..')) throw new ProfileError('invalid-content', field);
  const url = new URL(validateHttpsUrl(address.startsWith('https://') ? address : `https://${address}`, field));
  if (!/^\/(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+$/.test(url.pathname)) throw new ProfileError('invalid-content', field);
  return `git:${url.origin}${url.pathname}@${(git[2] as string).toLowerCase()}`;
}

export function packageIdentity(source: string): string {
  const canonical = pinnedSource(source, 'package.source');
  return canonical.slice(0, canonical.lastIndexOf('@')).replace(/\.git$/, '');
}

function descriptor(value: unknown, field: string): PortablePackage {
  requireRecord(value, ['source'], field, ['autoload', ...filters]);
  const output: PortablePackage = { source: pinnedSource(value.source, `${field}.source`) };
  if (Object.hasOwn(value, 'autoload')) {
    if (typeof value.autoload !== 'boolean') throw new ProfileError('invalid-content', `${field}.autoload`);
    output.autoload = value.autoload;
  }
  for (const key of filters) {
    if (!Object.hasOwn(value, key)) continue;
    requireDataArray(value[key], 64, `${field}.${key}`);
    output[key] = value[key].map(pattern => {
      if (typeof pattern !== 'string' || pattern.length > 240 || !/^[a-zA-Z0-9_./*?!+@-]+$/.test(pattern)) {
        throw new ProfileError('invalid-path', `${field}.${key}`);
      }
      const path = /^[!+-]/.test(pattern) ? pattern.slice(1) : pattern;
      if (path.split('/').some(part => !part || part === '.' || part === '..')) throw new ProfileError('invalid-path', `${field}.${key}`);
      return pattern;
    });
  }
  return output;
}

export function validatePackages(value: unknown): PortablePackage[] {
  requireDataArray(value, 64, 'packages');
  const identities = new Set<string>();
  return value.map((entry, index) => {
    const result = descriptor(entry, `packages[${index}]`);
    const identity = packageIdentity(result.source);
    if (identities.has(identity)) throw new ProfileError('path-conflict', `packages[${index}]`);
    identities.add(identity);
    return result;
  });
}

export function projectPackages(selected: unknown): ProjectionResult<PortablePackage[]> {
  requireDataArray(selected, 64, 'packages');
  const value: PortablePackage[] = [];
  const diagnostics: ProjectionDiagnostic[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < selected.length; index++) {
    const field = `packages[${index}]`;
    try {
      const input = typeof selected[index] === 'string' ? { source: selected[index] } : selected[index];
      requireDataRecord(input, field);
      const candidate: Record<string, unknown> = {};
      let position = 0;
      for (const key of Object.keys(input)) {
        if (['source', 'autoload', ...filters].includes(key)) candidate[key] = input[key];
        else diagnostics.push({ field: `${field}[${position}]`, code: 'omitted-field' });
        position++;
      }
      const result = descriptor(candidate, field);
      const identity = packageIdentity(result.source);
      if (identities.has(identity)) throw new ProfileError('path-conflict', field);
      identities.add(identity);
      value.push(result);
    } catch (error) {
      if (!(error instanceof ProfileError)) throw error;
      diagnostics.push({ field, code: 'unsupported-value' });
    }
  }
  return { value, diagnostics };
}
