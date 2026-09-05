import { ProfileError, requireDataArray, requireDataRecord, type ProjectionDiagnostic, type ProjectionResult } from './validation.ts';

export type PortableKeybindings = Record<string, string | string[]>;

// Namespaced public action identifiers from Pi 0.85.0; never materialize OS-dependent defaults.
const groups: Record<string, string> = {
  'tui.editor': 'cursorUp cursorDown historyPrevious historyNext cursorLeft cursorRight cursorWordLeft cursorWordRight cursorLineStart cursorLineEnd jumpForward jumpBackward pageUp pageDown deleteCharBackward deleteCharForward deleteWordBackward deleteWordForward deleteToLineStart deleteToLineEnd yank yankPop undo',
  'tui.input': 'newLine submit tab copy',
  'tui.select': 'up down pageUp pageDown confirm cancel',
  'tui.altScreen': 'pageUp pageDown halfPageUp halfPageDown lineUp lineDown previousPrompt nextPrompt search searchNext searchPrevious searchClose top bottom',
  app: 'interrupt clear exit suspend thinking.cycle thinking.toggle model.cycleForward model.cycleBackward model.select tools.expand editor.external clipboard.pasteImage message.copy message.followUp message.dequeue',
  'app.session': 'new tree fork resume togglePath toggleSort toggleNamedFilter rename delete deleteNoninvasive',
  'app.tree': 'foldOrUp unfoldOrDown editLabel toggleLabelTimestamp filter.default filter.noTools filter.userOnly filter.labeledOnly filter.all filter.cycleForward filter.cycleBackward',
  'app.models': 'save enableAll clearAll toggleProvider reorderUp reorderDown',
};
const actions = new Set(Object.entries(groups).flatMap(([prefix, names]) => names.split(' ').map(name => `${prefix}.${name}`)));
const modifiers = ['ctrl', 'shift', 'alt', 'super'];
const specialKeys = new Set('escape esc enter return tab space backspace delete insert clear home end pageUp pageDown up down left right'.split(' '));
const symbols = "`-=[]\\;',./!@#$%^&*()_|~{}:<>?";

function keyIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new ProfileError('invalid-content', field);
  }
  // Pi's parser splits on '+', so a literal '+' base is deliberately unsupported.
  const parts = value.split('+');
  const base = parts.pop();
  if (!base || !(specialKeys.has(base) || /^[a-z0-9]$/.test(base) || /^f(?:[1-9]|1[0-2])$/.test(base)
      || (base.length === 1 && symbols.includes(base)))
      || parts.some(part => !modifiers.includes(part)) || new Set(parts).size !== parts.length) {
    throw new ProfileError('invalid-content', field);
  }
  if (/^f(?:[1-9]|1[0-2])$/.test(base) && parts.length > 0) {
    throw new ProfileError('invalid-content', field);
  }
  const canonicalBase = base === 'esc' ? 'escape' : base === 'return' ? 'enter' : base;
  return [...modifiers.filter(modifier => parts.includes(modifier)), canonicalBase].join('+');
}

function binding(value: unknown, field: string): string | string[] {
  if (typeof value === 'string') {
    keyIdentity(value, field);
    return value;
  }
  requireDataArray(value, 16, field);
  const identities = new Set<string>();
  const output: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const identity = keyIdentity(value[index], `${field}[${index}]`);
    if (identities.has(identity)) throw new ProfileError('invalid-content', field);
    identities.add(identity);
    output.push(value[index] as string);
  }
  return output;
}

function collect(input: unknown, strict: boolean): ProjectionResult<PortableKeybindings> {
  requireDataRecord(input, 'keybindings');
  const value: PortableKeybindings = {};
  const diagnostics: ProjectionDiagnostic[] = [];
  const identities = new Set<string>();
  let index = 0;
  for (const action of Object.keys(input)) {
    const position = `keybindings[${index++}]`;
    if (!actions.has(action)) {
      if (strict) throw new ProfileError('invalid-shape', position);
      diagnostics.push({ field: position, code: 'omitted-field' });
      continue;
    }
    const field = `keybindings.${action}`;
    try {
      value[action] = binding(input[action], field);
    } catch (error) {
      if (strict || !(error instanceof ProfileError)) throw error;
      diagnostics.push({ field, code: 'unsupported-value' });
      continue;
    }
    const keys = value[action];
    for (const key of typeof keys === 'string' ? [keys] : keys) {
      const identity = keyIdentity(key, field);
      // Different contexts intentionally share keys; this requires review, not blanket rejection.
      if (identities.has(identity)) diagnostics.push({ field, code: 'shared-key' });
      identities.add(identity);
    }
  }
  return { value, diagnostics };
}

export function projectKeybindings(selected: unknown): ProjectionResult<PortableKeybindings> {
  return collect(selected, false);
}

export function validateKeybindings(value: unknown): PortableKeybindings {
  return collect(value, true).value;
}
