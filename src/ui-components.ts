import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import { CancellableLoader, SelectList, Text, matchesKey, truncateToWidth, type Component, type SelectItem, type TUI } from '@earendil-works/pi-tui';
import { en } from './locales/en.ts';

export function safeDisplay(value: string): string { return value.replace(/[\p{C}]/gu, '\uFFFD'); }

function listTheme(theme: Theme) {
  return {
    selectedPrefix: (text: string) => theme.fg('accent', text),
    selectedText: (text: string) => theme.fg('accent', text),
    description: (text: string) => theme.fg('muted', text),
    scrollInfo: (text: string) => theme.fg('dim', text),
    noMatch: (text: string) => theme.fg('warning', text),
  };
}

export function reviewComponent(tui: TUI, theme: Theme, done: () => void, lines: readonly string[]): Component {
  let page = 0;
  let pages = 1;
  const text = new Text(lines.map(safeDisplay).join('\n'), 1, 0);
  function navigation(selected = 'close'): SelectList {
    const items = [{ value: 'close', label: en.close as string }];
    if (page < pages - 1) items.push({ value: 'next', label: en.next });
    if (page > 0) items.push({ value: 'previous', label: en.previous });
    const list = new SelectList(items, 3, listTheme(theme));
    list.setSelectedIndex(Math.max(0, items.findIndex(item => item.value === selected)));
    list.onSelect = item => {
      if (item.value === 'close') { done(); return; }
      page = Math.max(0, Math.min(pages - 1, page + (item.value === 'next' ? 1 : -1)));
      choices = navigation(item.value);
      tui.requestRender();
    };
    list.onCancel = done;
    return list;
  }
  let choices = navigation();
  return {
    render(width) {
      const rows = Math.max(1, tui.terminal.rows - 10);
      const body = text.render(width);
      const previousPages = pages;
      const previousPage = page;
      pages = Math.max(1, Math.ceil(body.length / rows));
      page = Math.min(page, pages - 1);
      if (pages !== previousPages || page !== previousPage) choices = navigation(choices.getSelectedItem()?.value);
      return [truncateToWidth(theme.fg('accent', `${en.review} (${page + 1}/${pages})`), width),
        ...body.slice(page * rows, (page + 1) * rows), '', ...choices.render(width), truncateToWidth(en.pageHelp, width)];
    },
    handleInput(data) { choices.handleInput(data); tui.requestRender(); },
    invalidate() { text.invalidate(); choices.invalidate(); },
  };
}

export async function review(ctx: ExtensionCommandContext, lines: readonly string[]): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keys, done) => reviewComponent(tui, theme, () => done(), lines));
}

const selectAllValue = '__setup_share_select_all';
const continueValue = '__setup_share_continue';

export function selectionComponent(
  tui: TUI, theme: Theme, done: (ids: string[] | undefined) => void, items: readonly SelectItem[], selectAllLabel?: string,
): Component {
  if (items.some(item => item.value === selectAllValue || item.value === continueValue)) throw new Error('Reserved selection value');
  const selected = new Set<string>();
  let list: SelectList;
  function rebuild(index = 0): void {
    const controls = selectAllLabel && items.length ? [{ value: selectAllValue, label: safeDisplay(selectAllLabel) }] : [];
    list = new SelectList([...controls, ...items.map(item => ({ value: item.value, label: `${selected.has(item.value) ? '[x]' : '[ ]'} ${safeDisplay(item.label)}` })),
      { value: continueValue, label: en.continue }], Math.max(2, Math.min(12, tui.terminal.rows - 8)), listTheme(theme));
    list.setSelectedIndex(index);
    list.onCancel = () => done(undefined);
    list.onSelect = item => {
      if (item.value === continueValue) { done([...selected]); return; }
      if (item.value === selectAllValue) {
        for (const entry of items) selected.add(entry.value);
        rebuild(0);
        return;
      }
      if (selected.has(item.value)) selected.delete(item.value); else selected.add(item.value);
      rebuild(controls.length + items.findIndex(entry => entry.value === item.value));
    };
  }
  rebuild();
  return {
    render(width) { return [truncateToWidth(theme.fg('accent', en.selection), width), ...list.render(width), truncateToWidth(en.selectionHelp, width)]; },
    handleInput(data) {
      if (matchesKey(data, 'space')) {
        const item = list.getSelectedItem();
        if (item && item.value !== continueValue) list.onSelect?.(item);
      } else list.handleInput(data);
      tui.requestRender();
    },
    invalidate() { list.invalidate(); },
  };
}

export async function selectItems(
  ctx: ExtensionCommandContext, items: readonly SelectItem[], selectAllLabel?: string,
): Promise<string[] | undefined> {
  return ctx.ui.custom<string[] | undefined>((tui, theme, _keys, done) => selectionComponent(tui, theme, done, items, selectAllLabel));
}

export async function confirmStep(ctx: ExtensionCommandContext, title: string, warning: string): Promise<boolean> {
  return ctx.ui.custom<boolean>((tui, theme, _keys, done) => {
    const text = new Text(warning, 1, 1);
    const choices = new SelectList([{ value: 'later', label: en.later }, { value: 'confirm', label: en.confirm }], 2, listTheme(theme));
    choices.onSelect = item => done(item.value === 'confirm');
    choices.onCancel = () => done(false);
    return {
      render(width) { return [truncateToWidth(theme.fg('accent', title), width), ...text.render(width), ...choices.render(width), truncateToWidth(en.confirmHelp, width)]; },
      handleInput(data) { choices.handleInput(data); tui.requestRender(); },
      invalidate() { text.invalidate(); choices.invalidate(); },
    };
  });
}

export async function runOperation<T>(ctx: ExtensionCommandContext, title: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const result = await ctx.ui.custom<{ value: T } | { error: unknown }>((tui, theme, _keys, done) => {
    const loader = new CancellableLoader(tui, text => theme.fg('accent', text), text => theme.fg('muted', text), title);
    loader.onAbort = () => { loader.setMessage(en.cancelling); tui.requestRender(); };
    // Keep the modal and command guard until the operation settles, even after cancellation.
    void Promise.resolve().then(() => operation(loader.signal)).then(value => done({ value }), error => done({ error })).finally(() => loader.dispose());
    return {
      render(width) { return [...loader.render(width), ...new Text(en.operationHelp, 1, 0).render(width)]; },
      handleInput(data) { loader.handleInput(data); },
      invalidate() { loader.invalidate(); },
      dispose() { loader.dispose(); },
    };
  });
  if ('error' in result) throw result.error;
  return result.value;
}
