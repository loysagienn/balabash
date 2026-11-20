// The restart tool server: request_restart records a
// system.restart.requested event; the restart module then waits for the safe
// window and exits into the supervisor. A dangerous capability — only the
// coordinator and engineer list it in their tool bundles. The tool changes nothing by itself: the event is the
// request, the log is the audit trail.

import type { JsonObject } from '../core/contract.ts';
import { getThread } from '../core/threads.ts';
import { bundleState } from '../runtime/bundle.ts';
import { requestRestart } from '../runtime/restart.ts';
import type { ToolFunction } from './mcp-client.ts';
import type { BuiltinServerCallContext, BuiltinToolServer } from './tool-manager.ts';

export const RESTART_SERVER_NAME = 'restart';
export const REQUEST_RESTART_FUNCTION_NAME = 'request_restart';

const REQUEST_RESTART_FUNCTION: ToolFunction = {
  functionName: REQUEST_RESTART_FUNCTION_NAME,
  serverName: RESTART_SERVER_NAME,
  toolName: REQUEST_RESTART_FUNCTION_NAME,
  description:
    'Request an app restart using the existing build. End your turn after the call. The restart waits for ' +
    'all agent turns (including yours and the secretary’s), programs, commands and remote ' +
    'engine work to finish, and for 20 seconds of log quiet. After the restart, system.restart.completed ' +
    'is delivered to this thread, or to the main thread if this one has ended.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Why the restart is needed, e.g. what was changed and built.',
      },
    },
    required: ['reason'],
    additionalProperties: false,
  },
};

// A warning when dist/ is missing or predates the last edit — the restart
// would boot nothing or the previous bundle. A convention nudge, not a gate:
// the agent owns building.
async function getStaleBuildWarning(): Promise<string | null> {
  switch (await bundleState()) {
    case 'missing':
      return 'WARNING: dist/app.js does not exist — run `npm run build` before the restart, or it will fail to boot.';
    case 'stale':
      return 'WARNING: sources changed after the last build — run `npm run build` first, or the restart will boot the previous bundle.';
    case 'current':
      return null;
  }
}

async function requestRestartTool(args: JsonObject, ctx: BuiltinServerCallContext): Promise<string> {
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';

  if (!reason) {
    throw new Error('request_restart requires a non-empty reason');
  }

  const thread = await getThread(ctx.threadId);
  if (!thread) throw new Error('The requesting thread does not exist');
  const staleWarning = await getStaleBuildWarning();

  await requestRestart({ workspaceId: ctx.workspaceId, threadId: ctx.threadId, reason, author: { actor: 'agent', agentName: thread.agent } });

  const lines = [
    'Restart is pending. End your turn so the restart can proceed once all turns and background work have finished and the log has been quiet for 20 seconds.',
    'After the restart, system.restart.completed is delivered to this thread, or to the main thread if this one has ended.',
    ...(staleWarning ? [staleWarning] : []),
  ];

  return lines.join('\n');
}

export function createRestartToolServer(): BuiltinToolServer {
  return {
    name: RESTART_SERVER_NAME,
    functionNames: [REQUEST_RESTART_FUNCTION_NAME],

    getFunctions: async () => [REQUEST_RESTART_FUNCTION],

    call: async (toolName, args, ctx) => {
      if (toolName !== REQUEST_RESTART_FUNCTION_NAME) {
        throw new Error(`Unknown restart tool "${toolName}"`);
      }

      return requestRestartTool(args, ctx);
    },
  };
}
