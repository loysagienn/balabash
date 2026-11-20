// The node `system`: the installation itself. A restart is the one way a
// rebuilt bundle or a changed configuration goes live, and it is requested,
// not performed: the request is an event of the log, and the restart module
// (src/runtime/restart.ts) exits into the supervisor once nothing is in
// flight.

import { z } from 'zod';
import { CapabilityError, capability, node } from '../catalog/index.ts';
import { taskAuthorLabel } from '../utils/task-author.ts';
import { callAuthor } from './call-author.ts';
import { bundleState } from '../runtime/bundle.ts';
import { requestRestart as recordRequest } from '../runtime/restart.ts';

const requestRestart = capability({
  name: 'request_restart',
  summary: 'Request an app restart that makes the built bundle live',
  description:
    'Request an app restart using the existing build. End your turn after the call. The restart waits for all agent turns, including yours, and for background work to finish. After the restart, system.restart.completed is delivered to this thread, or to the main thread if this one has ended.',
  input: z.strictObject({
    reason: z.string().min(1).describe('What was changed and built.'),
  }),
  output: z.strictObject({
    build: z
      .enum(['current', 'stale'])
      .describe('stale: the sources changed after the last build, so the restart boots the previous bundle.'),
  }),
  async run(input, ctx) {
    const { caller } = ctx;
    const author = callAuthor(ctx);
    const reason = input.reason.trim();

    if (!reason) {
      throw new CapabilityError('invalid_input', 'reason is blank: say what was changed and built.');
    }

    // A restart without a bundle has nothing to boot: it is not registered.
    const build = await bundleState();

    if (build === 'missing') {
      throw new CapabilityError(
        'conflict',
        'There is no built bundle (dist/app.js), so the restart is not registered: build the app, then request the restart again.',
      );
    }

    await recordRequest({
      workspaceId: caller.workspaceId,
      threadId: caller.threadId,
      reason,
      requestedBy: author.task ? taskAuthorLabel(author.task.slug) : caller.agentName,
      task: author.task,
    });

    return { build };
  },
});

export const system = node({
  name: 'system',
  summary:
    'The Balabash installation itself: restarting the app so that a rebuilt bundle or a changed configuration goes live.',
  guide: [
    {
      text: 'A restart is requested, never performed by hand: build first, then `system_request_restart`, then end your turn. Your thread keeps its session and continues after the restart.',
    },
  ],
  children: [requestRestart],
});
