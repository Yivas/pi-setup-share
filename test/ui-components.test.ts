import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth, type Component, type TUI } from '@earendil-works/pi-tui';
import { reviewComponent, runOperation, safeDisplay, selectionComponent } from '../src/ui-components.ts';

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const tui = (rows: number) => ({ terminal: { rows }, requestRender() {} }) as unknown as TUI;

for (const [width, height] of [[80, 24], [120, 40]] as const) {
  test(`native review and selection fit ${width}x${height}`, () => {
    const host = tui(height);
    const items = Array.from({ length: 64 }, (_, index) => ({ value: String(index), label: `${index}: ${'synthetic long name '.repeat(12)}` }));
    const components = [reviewComponent(host, theme, () => {}, items.map(item => item.label)), selectionComponent(host, theme, () => {}, items)];
    for (const component of components) {
      const lines = component.render(width);
      assert.ok(lines.length <= height);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      component.handleInput?.('\x1b[B');
      component.handleInput?.('\r');
      component.invalidate();
      assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
    }
  });
}

test('one-page reviews expose no inert pagination controls', () => {
  const component = reviewComponent(tui(24), theme, () => {}, ['Synthetic review']);
  const rendered = component.render(80).join('\n');
  assert.equal(rendered.includes('Next page'), false);
  assert.equal(rendered.includes('Previous page'), false);
});

test('selections begin empty, Space toggles and Enter accepts Continue', () => {
  let result: string[] | undefined;
  const component = selectionComponent(tui(24), theme, ids => { result = ids; }, [{ value: 'a', label: 'First' }]);
  assert.match(component.render(80).join('\n'), /\[ \] First/);
  component.handleInput?.(' ');
  assert.match(component.render(80).join('\n'), /\[x\] First/);
  component.handleInput?.('\x1b[B');
  component.handleInput?.('\r');
  assert.deepEqual(result, ['a']);
});

test('Escape discards a pending selection and display removes terminal controls', () => {
  let called = false;
  const component = selectionComponent(tui(24), theme, ids => { called = true; assert.equal(ids, undefined); }, [{ value: 'a', label: 'First' }]);
  component.handleInput?.(' ');
  component.handleInput?.('\x1b');
  assert.equal(called, true);
  assert.equal(/[\p{C}]/u.test(safeDisplay('\x1b]52;c;synthetic\x07\u202e')), false);
});

test('cancellation keeps operation UI open until in-flight work settles', async () => {
  let component: Component | undefined;
  let finish: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  let completed = false;
  const ctx = { ui: { custom: (factory: (...args: any[]) => Component) => new Promise(resolve => {
    component = factory(tui(24), theme, {}, resolve);
  }) } } as unknown as ExtensionCommandContext;
  const running = runOperation(ctx, 'Synthetic work', async currentSignal => {
    signal = currentSignal;
    await new Promise<void>(resolve => { finish = resolve; });
    return 42;
  }).then(value => { completed = true; return value; });
  await Promise.resolve();
  component?.handleInput?.('\x1b');
  assert.equal(signal?.aborted, true);
  assert.equal(completed, false);
  finish?.();
  assert.equal(await running, 42);
});
