import type { ReportExtensionFailure } from '../capabilities/extensions.ts';
import { appendEvent } from '../core/append.ts';
import { SYSTEM_EXCEPTION } from '../core/envelope.ts';

export const journalExtensionFailure: ReportExtensionFailure = async ({ scope, file, error, workspaceId = null }) => {
  await appendEvent({
    type: SYSTEM_EXCEPTION, actor: 'system', workspaceId,
    payload: { scope, error: `${file}: ${error}` },
  });
};
