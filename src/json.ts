import { ProfileError, requireDataArray, requireDataRecord } from './validation.ts';

export function stringifyBounded(value: unknown, limit: number, pretty = true): string {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 * 1024 * 1024) throw new ProfileError('limit-exceeded', 'json');
  let size = 1; // Final newline.
  let nodes = 0;
  const add = (bytes: number): void => {
    size += bytes;
    if (size > limit) throw new ProfileError('limit-exceeded', 'json');
  };
  function quoted(text: string): void {
    add(2);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92) add(2);
      else if (code < 32) add([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
      else if (code < 128) add(1);
      else if (code < 2048) add(2);
      else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { add(4); index++; }
      else if (code >= 0xd800 && code <= 0xdfff) add(6);
      else add(3);
    }
  }
  function visit(input: unknown, depth: number): void {
    if (++nodes > 65_536 || depth > 32) throw new ProfileError('limit-exceeded', 'json');
    if (typeof input === 'string') { quoted(input); return; }
    if (input === null) { add(4); return; }
    if (typeof input === 'boolean') { add(input ? 4 : 5); return; }
    if (typeof input === 'number' && Number.isFinite(input)) { add(String(input).length); return; }
    const array = Array.isArray(input);
    if (array) requireDataArray(input, 32_768, 'json');
    else requireDataRecord(input, 'json');
    const entries = array ? input.map(entry => [undefined, entry] as const) : Object.entries(input);
    add(2);
    for (let index = 0; index < entries.length; index++) {
      if (index > 0) add(1);
      if (pretty) add(1 + 2 * (depth + 1));
      const [key, entry] = entries[index] as readonly [string | undefined, unknown];
      if (!array) { quoted(key as string); add(pretty ? 2 : 1); }
      visit(entry, depth + 1);
    }
    if (pretty && entries.length) add(1 + 2 * depth);
  }
  visit(value, 0);
  return `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`;
}

export function parseBoundedJson(text: string, limit = 4 * 1024 * 1024): unknown {
  if (typeof text !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 32 * 1024 * 1024
      || Buffer.byteLength(text) > limit) throw new ProfileError('limit-exceeded', 'json');
  let depth = 0;
  let tokens = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {
      if (++depth > 32 || ++tokens > 65_536) throw new ProfileError('limit-exceeded', 'json');
    } else if (character === '}' || character === ']') depth--;
    else if ((character === ',' || character === ':') && ++tokens > 65_536) throw new ProfileError('limit-exceeded', 'json');
  }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new ProfileError('invalid-json', 'json'); }
}
