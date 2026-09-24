// Worker used by the abrupt-termination fixtures of test/literal-swap.test.ts.
//
// It runs the swap until the requested durable cut, writes a marker so the parent knows the state is on
// disk, and then parks. The parent terminates it abruptly, so nothing of this execution unit runs
// afterwards and the remaining state can only be rebuilt from the journal on disk. The work runs inside an
// async function rather than as a top-level await, because terminating a worker with an unsettled
// top-level await makes Node print a warning that would only add noise to the validation output.

import { writeFile } from 'node:fs/promises';
import { workerData } from 'node:worker_threads';
import { loadSwapPlan, runSwap } from '../src/literal-swap.ts';

const cut = workerData as { journalPath: string; stop: string; marker: string };

void (async () => {
  const plan = await loadSwapPlan(cut.journalPath);
  await runSwap(plan, {
    onTransition: async ({ state }) => {
      if (state !== cut.stop) return;
      await writeFile(cut.marker, 'ready');
      // Keeps the worker alive until the parent terminates it, so the cut is abrupt and not a clean exit.
      setInterval(() => undefined, 1 << 30);
      await new Promise(() => {});
    },
  });
})().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
