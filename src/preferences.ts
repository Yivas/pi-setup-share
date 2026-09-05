import { Buffer } from 'node:buffer';
import { ProfileError, requireDataRecord, type ProjectionDiagnostic, type ProjectionResult } from './validation.ts';

type Scalar = string | number | boolean;
type Check = (value: unknown) => boolean;
type Schema = { [key: string]: Check | Schema };
export interface PortablePreferences { [key: string]: Scalar | PortablePreferences }

const boolean = (value: unknown): boolean => typeof value === 'boolean';
const integer = (min: number, max: number): Check => value =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const enumeration = (...values: string[]): Check => value => typeof value === 'string' && values.includes(value);
const identifier = (bytes: number): Check => value => typeof value === 'string'
  && Buffer.byteLength(value, 'utf8') <= bytes && !value.includes('://')
  && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value);

// These are profile limits, not a claim that Pi validates its settings on disk.
const schema: Schema = {
  defaultProvider: identifier(128),
  defaultModel: identifier(256),
  defaultThinkingLevel: enumeration('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'),
  theme: enumeration('dark', 'light'),
  tuiMode: enumeration('regular'),
  steeringMode: enumeration('all', 'one-at-a-time'),
  followUpMode: enumeration('all', 'one-at-a-time'),
  hideThinkingBlock: boolean,
  showCacheMissNotices: boolean,
  quietStartup: boolean,
  collapseChangelog: boolean,
  showHardwareCursor: boolean,
  doubleEscapeAction: enumeration('fork', 'tree', 'none'),
  treeFilterMode: enumeration('default', 'no-tools', 'user-only', 'labeled-only', 'all'),
  editorPaddingX: integer(0, 3),
  outputPad: integer(0, 1),
  autocompleteMaxVisible: integer(3, 20),
  compaction: { enabled: boolean, reserveTokens: integer(0, 1_000_000), keepRecentTokens: integer(0, 1_000_000) },
  branchSummary: { reserveTokens: integer(0, 1_000_000), skipPrompt: boolean },
  images: { autoResize: boolean, blockImages: boolean },
  terminal: { showImages: boolean, clearOnShrink: boolean, showTerminalProgress: boolean },
  warnings: { anthropicExtraUsage: boolean },
  markdown: {
    mermaid: enumeration('off', 'final', 'streaming'),
    codeBlockIndent: value => typeof value === 'string' && /^ {0,32}$/.test(value),
  },
};

function collect(
  input: unknown, fields: Schema, path: string, diagnostics: ProjectionDiagnostic[], strict: boolean,
): PortablePreferences {
  requireDataRecord(input, path);
  const output: PortablePreferences = {};
  let index = 0;
  for (const key of Object.keys(input)) {
    const position = `${path}[${index++}]`;
    if (!Object.hasOwn(fields, key)) {
      if (strict) throw new ProfileError('invalid-shape', position);
      diagnostics.push({ field: position, code: 'omitted-field' });
      continue;
    }
    const rule = fields[key];
    const field = `${path}.${key}`;
    if (typeof rule === 'function') {
      if (!rule(input[key])) {
        if (strict) throw new ProfileError('invalid-content', field);
        diagnostics.push({ field, code: 'unsupported-value' });
        continue;
      }
      output[key] = input[key] as Scalar;
    } else if (rule) {
      output[key] = collect(input[key], rule, field, diagnostics, strict);
    }
  }
  return output;
}

// The caller supplies only settings selected for export, never effective project settings.
export function projectPreferences(selected: unknown): ProjectionResult<PortablePreferences> {
  const diagnostics: ProjectionDiagnostic[] = [];
  return { value: collect(selected, schema, 'preferences', diagnostics, false), diagnostics };
}

export function validatePreferences(value: unknown): PortablePreferences {
  return collect(value, schema, 'preferences', [], true);
}
