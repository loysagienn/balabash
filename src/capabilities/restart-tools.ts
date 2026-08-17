// The restart tool server: request_restart records a
// system.restart.requested event; the restart module then waits for the safe
// window and exits into the supervisor. A dangerous capability — only the
// coordinator and the repo-owning agents (engineer, scheduler) list it in
// their tool bundles. The tool changes nothing by itself: the event is the
// request, the log is the audit trail.

import { stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { JsonObject } from '../core/contract.ts';
import { appendEvent } from '../core/append.ts';
import { SYSTEM_RESTART_REQUESTED } from '../core/envelope.ts';
import { getThread } from '../core/threads.ts';
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
    'immediately: it waits for a safe window — every non-main thread closed (including the requesting ' +
    'one), no running turn, 20 seconds of log quiet — then the process restarts under the supervisor. ' +
    'After the restart a system.restart.completed event is delivered to the requesting thread (or to the ' +
    'main thread when it has already finished). Set force=true only when the user explicitly wants active ' +
    'threads cancelled to let the restart through.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Why the restart is needed, e.g. what was changed and built.',
      },
      force: {
        type: ['boolean', 'null'],
        description: 'Cancel all active non-main threads instead of waiting for them. Null for the normal wait.',
      },
    },
    required: ['reason'],
    additionalProperties: false,
  },
};

// Newest mtime across the source tree, to warn when dist/ predates the last
// edit — the restart would boot the previous bundle. A convention nudge, not
// a gate: the agent owns building.
const WATCHED_SOURCES = ['src', 'agents', 'tools', 'tasks', 'build', 'prisma', 'mcp-servers', 'package.json', 'supervisor.js'];

async function newestMtimeMs(target: string): Promise<number> {
  let stats;

  try {
    stats = await stat(target);
  } catch {
    return 0;
  }

  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  const entries = await readdir(target, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => newestMtimeMs(path.join(target, entry.name))));

  return Math.max(stats.mtimeMs, ...nested);
}

async function getStaleBuildWarning(): Promise<string | null> {
  const distPath = path.resolve('dist', 'app.js');
  let distStats;

  try {
    distStats = await stat(distPath);
  } catch {
    return 'WARNING: dist/app.js does not exist — run `npm run build` before the restart, or it will fail to boot.';
  }

  const sourceMtimes = await Promise.all(WATCHED_SOURCES.map(source => newestMtimeMs(path.resolve(source))));

  if (Math.max(...sourceMtimes) > distStats.mtimeMs) {
    return 'WARNING: sources changed after the last build — run `npm run build` first, or the restart will boot the previous bundle.';
  }

  return null;
}

async function requestRestart(args: JsonObject, ctx: BuiltinServerCallContext): Promise<string> {
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';

  if (!reason) {
    throw new Error('request_restart requires a non-empty reason');
  }

  const force = args.force === true;
  const thread = await getThread(ctx.threadId);
  const staleWarning = await getStaleBuildWarning();

  await appendEvent({
    type: SYSTEM_RESTART_REQUESTED,
    actor: 'system',
    userId: ctx.userId,
    threadId: ctx.threadId,
    payload: {
      reason,
      ...(force ? { force: true } : {}),
      ...(thread ? { requestedBy: thread.agent } : {}),
    },
  });

  const lines = [
    force
      ? 'Restart is pending; all active non-main threads will be cancelled to open the safe window.'
      : 'Restart is pending. It waits for a safe window: every non-main thread closed (including this one, if the request came from an agent thread), no running turn, and 20 seconds of log quiet.',
    'Finish this thread to let the restart happen; a system.restart.completed event will report it.',
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

      return requestRestart(args, ctx);
    },
  };
}
