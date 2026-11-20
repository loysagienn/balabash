import type { ReportExtensionFailure } from '../capabilities/extensions.ts';
import { appendEvent } from '../core/append.ts';
import { SYSTEM_EXCEPTION } from '../core/envelope.ts';

export function journalExtensionFailure(scope: string): ReportExtensionFailure {
  return async ({ file, error, workspaceId = null }) => {
    await appendEvent({
      type: SYSTEM_EXCEPTION, actor: 'system', workspaceId,
      payload: { scope, error: `${file}: ${error}` },
    });
  };
}
