// The restart tool server: request_restart records a
// system.restart.requested event; the restart module then waits for the safe
// window and exits into the supervisor. A dangerous capability — only the
// coordinator and the engineer and scheduler agents list it in
// their tool bundles. The tool changes nothing by itself: the event is the
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
    'Request an app restart so that a freshly built bundle goes live. The restart does not happen ' +
    'immediately: it waits for a safe window — no agent turn in flight in any thread (the requesting ' +
    'one included), no secretary turn, no running workspace job, 20 seconds of log quiet — then the ' +
    'process restarts under the supervisor. A thread waiting between turns is no obstacle: it keeps its ' +
    'session and continues after the restart. A system.restart.completed event is then delivered to the ' +
    'requesting thread (or to the main thread when it has already finished). Set force=true only when the ' +
    'user explicitly wants the restart without waiting for agent turns: the turns in flight are cut off ' +
    'and their threads resume with a note about it.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Why the restart is needed, e.g. what was changed and built.',
      },
      force: {
        type: ['boolean', 'null'],
        description: 'Restart without waiting for agent turns in flight — they are cut off. Null for the normal wait.',
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

  const force = args.force === true;
  const thread = await getThread(ctx.threadId);
  const staleWarning = await getStaleBuildWarning();

  await requestRestart({ workspaceId: ctx.workspaceId, threadId: ctx.threadId, reason, force, requestedBy: thread?.agent ?? null });

  const lines = [
    force
      ? 'Restart is pending and forced: it does not wait for agent turns — those in flight are cut off, and their threads resume with a note.'
      : 'Restart is pending. It waits for a safe window: no agent turn in flight (this one included, if the request came from an agent thread), no secretary turn, no running job, and 20 seconds of log quiet.',
    'End this turn to let the restart happen. This thread keeps its session and continues after the restart; a system.restart.completed event will report it.',
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
