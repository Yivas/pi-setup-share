// Worker used by the abrupt-termination fixtures of test/literal-swap.test.ts.
//
// It runs the swap until the requested durable cut, writes a marker so the parent knows the state is on
// disk, and then parks forever. The parent terminates it abruptly, so nothing of this execution unit runs
// afterwards and the remaining state can only be rebuilt from the journal on disk.

import { writeFile } from 'node:fs/promises';
import { workerData } from 'node:worker_threads';
import { loadSwapPlan, runSwap } from '../src/literal-swap.ts';

const cut = workerData as { journalPath: string; stop: string; marker: string };

const plan = await loadSwapPlan(cut.journalPath);
await runSwap(plan, {
  onTransition: async ({ state }) => {
    if (state !== cut.stop) return;
    await writeFile(cut.marker, 'ready');
    await new Promise(() => {});
  },
});
