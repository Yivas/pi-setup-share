import { join } from 'node:path';
import { discoverResources, type ResourceCandidate } from './files.ts';
import type { ResourceKind } from './profile.ts';

export interface GlobalResourceCandidate { root: string; origin: string; candidate: ResourceCandidate }
export interface GlobalResourceInventory { items: GlobalResourceCandidate[]; omitted: number; truncated: boolean }

// Only conventional user roots are inspected. Package contents and project settings have separate contracts.
export async function discoverGlobalResources(agentDir: string, homeDir: string, signal?: AbortSignal): Promise<GlobalResourceInventory> {
  const roots: { root: string; origin: string; kind: ResourceKind; external?: boolean }[] = [
    { root: join(agentDir, 'extensions'), origin: 'Pi extensions', kind: 'extension' },
    { root: join(agentDir, 'skills'), origin: 'Pi skills', kind: 'skill' },
    { root: join(agentDir, 'prompts'), origin: 'Pi prompts', kind: 'prompt' },
    { root: join(agentDir, 'themes'), origin: 'Pi themes', kind: 'theme' },
    { root: join(agentDir, 'agents'), origin: 'Pi agents', kind: 'agent' },
    { root: join(homeDir, '.agents', 'skills'), origin: 'User skills', kind: 'skill', external: true },
    { root: join(homeDir, '.agents'), origin: 'User agents', kind: 'agent', external: true },
  ];
  const items: GlobalResourceCandidate[] = [];
  let omitted = 0;
  let truncated = false;
  for (const { root, origin, kind, external } of roots) {
    const inventory = await discoverResources(root, kind, signal, 1024, external && kind === 'agent' ? ['skills'] : []);
    omitted += inventory.omitted;
    truncated ||= inventory.truncated;
    for (const candidate of inventory.candidates) {
      if (items.length >= 256) { omitted++; truncated = true; continue; }
      items.push({ root, origin, candidate });
    }
  }
  return { items, omitted, truncated };
}
