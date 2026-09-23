import { ProfileError, requireDataArray, requireRecord } from './validation.ts';

export const TRANSFER_CATEGORIES = [
  'preferences', 'keybindings', 'mcpServers', 'subagents', 'packages',
  'extension', 'skill', 'prompt', 'theme', 'agent', 'resourceFiles', 'project', 'externalResources', 'pluginSettings',
] as const;
export type TransferCategory = (typeof TRANSFER_CATEGORIES)[number];
export const TRANSFER_REASONS = ['unsupported', 'excluded', 'unselected', 'limit', 'collision'] as const;
export type TransferReason = (typeof TRANSFER_REASONS)[number];
export const RECEIVER_ACTIONS = [
  'configure-credentials', 'install-tools', 'review-resources', 'verify-endpoints',
  'verify-models', 'review-omissions', 'check-platform', 'respect-licenses',
] as const;
export type ReceiverAction = (typeof RECEIVER_ACTIONS)[number];

export interface TransferReport {
  scanned: TransferCategory[];
  partial: TransferCategory[];
  notExamined: TransferCategory[];
  omissions: { category: TransferCategory; reason: TransferReason; count: number }[];
  actions: ReceiverAction[];
}

function knownList<T extends string>(value: unknown, allowed: readonly T[], field: string): T[] {
  requireDataArray(value, allowed.length, field);
  if (value.some(item => typeof item !== 'string' || !allowed.includes(item as T))
      || new Set(value).size !== value.length) throw new ProfileError('invalid-content', field);
  return value as T[];
}

export function validateTransferReport(value: unknown): TransferReport {
  requireRecord(value, ['scanned', 'partial', 'notExamined', 'omissions', 'actions'], 'transfer');
  const scanned = knownList(value.scanned, TRANSFER_CATEGORIES, 'transfer.scanned');
  const partial = knownList(value.partial, TRANSFER_CATEGORIES, 'transfer.partial');
  const notExamined = knownList(value.notExamined, TRANSFER_CATEGORIES, 'transfer.notExamined');
  if (new Set([...scanned, ...partial, ...notExamined]).size !== scanned.length + partial.length + notExamined.length) {
    throw new ProfileError('invalid-content', 'transfer');
  }
  requireDataArray(value.omissions, 64, 'transfer.omissions');
  const omissions = value.omissions.map((entry, index) => {
    const field = `transfer.omissions[${index}]`;
    requireRecord(entry, ['category', 'reason', 'count'], field);
    if (!TRANSFER_CATEGORIES.includes(entry.category as TransferCategory)
        || !TRANSFER_REASONS.includes(entry.reason as TransferReason)
        || typeof entry.count !== 'number' || !Number.isSafeInteger(entry.count)
        || entry.count < 1 || entry.count > 4096) throw new ProfileError('invalid-content', field);
    return { category: entry.category as TransferCategory, reason: entry.reason as TransferReason, count: entry.count };
  });
  if (new Set(omissions.map(item => `${item.category}/${item.reason}`)).size !== omissions.length) {
    throw new ProfileError('invalid-content', 'transfer.omissions');
  }
  const actions = knownList(value.actions, RECEIVER_ACTIONS, 'transfer.actions');
  return { scanned: [...scanned], partial: [...partial], notExamined: [...notExamined], omissions, actions: [...actions] };
}
