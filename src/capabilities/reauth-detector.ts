// The reauthorization reaction (§10): a consumer over
// connection.reauthorization_required — detection itself happens in the tool
// manager when a refresh or call dies with UnauthorizedError. The reaction
// spawns an auth thread so the user gets walked through re-authorizing, and
// raises a thread.notification (the attention plan is orthogonal to the
// context plan — §5.2). One active auth thread per workspace is enough: a
// second detection while it works is a no-op, the auth agent sees the fresh
// statuses in its tool descriptions anyway.

import { appendEvent } from '../core/append.ts';
import { startConsumer, type Consumer } from '../core/consumers.ts';
import { CONNECTION_REAUTHORIZATION_REQUIRED, THREAD_NOTIFICATION } from '../core/envelope.ts';
import { getMainThread, listThreads, startThread } from '../core/threads.ts';
import { getAgent } from './agent-catalog.ts';

const AUTH_AGENT = 'auth';

export function startReauthDetector(): Consumer {
  return startConsumer({
    name: 'reauth-detector',
    types: [CONNECTION_REAUTHORIZATION_REQUIRED],
    handler: async event => {
      const { userId } = event;

      if (!userId) {
        return;
      }

      const declaration = getAgent(AUTH_AGENT);

      if (!declaration) {
        console.warn('[reauth] auth agent is not in the catalog; skipping');
        return;
      }

      // At-least-once tolerance and no thread storms: one active auth thread
      // serves every pending reauthorization of the workspace.
      const activeThreads = await listThreads(userId, { status: 'active' });

      if (activeThreads.some(thread => thread.agent === AUTH_AGENT)) {
        return;
      }

      const main = await getMainThread(userId);

      if (!main) {
        return;
      }

      const server = typeof event.payload.server === 'string' ? event.payload.server : 'unknown';
      const error = typeof event.payload.error === 'string' ? event.payload.error : '';

      const thread = await startThread({
        userId,
        parentThreadId: main.id,
        agent: AUTH_AGENT,
        title: `Re-authorize ${server}`,
        input: `Authorization for the "${server}" integration has expired${error ? ` (${error})` : ''}. Walk the user through re-authorizing it.`,
        icon: declaration.icon,
        actor: 'system',
      });

      await appendEvent({
        type: THREAD_NOTIFICATION,
        actor: 'system',
        userId,
        threadId: thread.id,
        payload: {
          level: 'normal',
          text: `Authorization for "${server}" has expired — re-authorize it in the new topic.`,
        },
      });
    },
  });
}
