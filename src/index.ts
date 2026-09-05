import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { en } from './locales/en.ts';
import { createPackageInstaller } from './pi-installer.ts';
import { errorMessage, runSetupShare } from './ui.ts';

export default function setupShare(pi: ExtensionAPI): void {
  let running = false;
  pi.registerCommand('setup-share', {
    description: en.commandDescription,
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui' || !ctx.hasUI) return;
      if (running) { ctx.ui.notify(en.busy, 'warning'); return; }
      running = true;
      try { await runSetupShare(ctx, getAgentDir(), createPackageInstaller); }
      catch (error) { ctx.ui.notify(errorMessage(error), 'error'); }
      finally { running = false; }
    },
  });
}
