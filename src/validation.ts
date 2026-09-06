export type ProfileErrorCode =
  | 'invalid-json' | 'invalid-shape' | 'unsupported-version'
  | 'limit-exceeded' | 'invalid-path' | 'path-conflict' | 'invalid-content';

export class ProfileError extends Error {
  readonly code: ProfileErrorCode;
  readonly field: string;

  constructor(code: ProfileErrorCode, field: string) {
    // Values and unknown property names may contain secrets.
    super(code);
    this.name = 'ProfileError';
    this.code = code;
    this.field = field;
  }
}

export interface ProjectionDiagnostic {
  field: string;
  code: 'omitted-field' | 'unsupported-value' | 'shared-key';
  label?: string;
}

export interface ProjectionResult<T> {
  value: T;
  diagnostics: ProjectionDiagnostic[];
}

export function requireDataRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProfileError('invalid-shape', field);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ProfileError('invalid-shape', field);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256) throw new ProfileError('limit-exceeded', field);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new ProfileError('invalid-shape', field);
    }
  }
}

export function requireRecord(
  value: unknown, required: readonly string[], field: string, optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  requireDataRecord(value, field);
  if (required.some(key => !Object.hasOwn(value, key))
      || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new ProfileError('invalid-shape', field);
  }
}

export function requireDataArray(value: unknown, limit: number, field: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new ProfileError('invalid-shape', field);
  if (value.length > limit) throw new ProfileError('limit-exceeded', field);
  if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new ProfileError('invalid-shape', field);
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ProfileError('invalid-shape', field);
  }
}
