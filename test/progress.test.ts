import assert from 'node:assert/strict';
import test from 'node:test';
import { PROGRESS_BAR_WIDTH, PROGRESS_RECENT, ProgressTracker, progressLines } from '../src/ui-components.ts';

test('without a real total the bar stays indeterminate and shows the phase', () => {
  const tracker = new ProgressTracker('Checking saved imports…');
  tracker.begin('import 1');
  const lines = progressLines(tracker.snapshot(), 80);
  assert.equal(lines[0]?.includes('1/'), false);
  assert.equal(lines[0]?.includes('Checking saved imports…'), true);
  assert.equal(lines.some(line => line.includes('in progress: import 1')), true);
  assert.equal(lines.every(line => !line.includes('%')), true);
});

test('with a real total the bar fills proportionally and every outcome counts', () => {
  const tracker = new ProgressTracker('Exporting');
  tracker.setTotal(4);
  tracker.begin('item 1'); tracker.finish('completed');
  tracker.begin('item 2'); tracker.finish('skipped');
  tracker.begin('item 3'); tracker.finish('failed');
  const snapshot = tracker.snapshot();
  const lines = progressLines(snapshot, 80);
  assert.equal(lines[0]?.includes('3/4'), true);
  assert.equal(lines[1], 'completed: 1  skipped: 1  failed: 1');
  assert.deepEqual(snapshot.recent, ['item 1: completed', 'item 2: skipped', 'item 3: failed']);
  assert.equal(snapshot.running, null);
});

test('cancellation is requested, not proven, and the list stays bounded', () => {
  const tracker = new ProgressTracker('Staging');
  tracker.setTotal(50);
  for (let index = 0; index < PROGRESS_RECENT + 4; index++) {
    tracker.begin(`item ${index}`);
    tracker.finish('completed');
  }
  tracker.begin('item current');
  tracker.requestCancel();
  const lines = progressLines(tracker.snapshot(), 120);
  assert.equal(lines.some(line => line.includes('Cancellation requested')), true);
  assert.equal(lines.some(line => line.includes('in progress: item current')), true);
  assert.equal(lines.filter(line => line.includes(': completed')).length, PROGRESS_RECENT);
  for (const line of lines) assert.equal(line.length <= 120, true);
  assert.equal(lines.length <= 4 + PROGRESS_RECENT, true);
  assert.equal(PROGRESS_BAR_WIDTH <= 20, true);
});

test('labels are sanitized and a non-count total is refused', () => {
  const tracker = new ProgressTracker('Phase\u0007');
  tracker.begin('item\u0000');
  tracker.finish('completed');
  const lines = progressLines(tracker.snapshot(), 80);
  assert.equal(JSON.stringify(lines).includes('\\u0000'), false);
  assert.equal(JSON.stringify(lines).includes('\\u0007'), false);
  assert.throws(() => tracker.setTotal(-1));
  assert.throws(() => tracker.setTotal(1.5));
  tracker.setTotal(null);
  assert.equal(tracker.snapshot().total, null);
});
