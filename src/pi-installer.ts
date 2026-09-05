import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { PackageInstaller } from './import.ts';

/** Construct only after installation consent, with an exclusively claimed managed directory. */
export function createPackageInstaller(packageStore: string): PackageInstaller {
  return new DefaultPackageManager({
    cwd: packageStore,
    agentDir: packageStore,
    settingsManager: SettingsManager.inMemory(),
  });
}
