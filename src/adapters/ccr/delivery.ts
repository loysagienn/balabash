// CCR adapter, outbound side: a consumer delivering the thread surface into
// the operator's Claude app. Only claude-sdk threads have a session here
// (operator decision): the live SDKMessage stream rides the tap in index.ts;
// this consumer delivers lifecycle (session creation on thread.started, the
// summary as the final frame on a terminal) and the side channels
// (thread.notification, system.exception) — agent.message would duplicate
// the mirrored assistant frames and skips.
//
// At-least-once delivery is made idempotent by ccr_deliveries. The consumer
// starts at the head of the log on first registration: replaying workspace
// history into a fresh operator session would be worse than missing it.
// There is no analogue of "close the topic" in CCR — the accepted adaptation
// is the final summary frame + idle; the archived cse_* session stays
// readable in the app.

import { prisma } from '../../db/client.ts';
import { startConsumer } from '../../core/consumers.ts';
import type { Consumer } from '../../core/consumers.ts';
import type { Event, ThreadSummary } from '../../core/contract.ts';
import { TERMINAL_TYPES, THREAD_NOTIFICATION, THREAD_STARTED } from '../../core/envelope.ts';
import { getAgent } from '../../capabilities/agent-catalog.ts';
import { assistantTextFrame, systemInitFrame } from './frames.ts';
import { isSessionGoneError } from './session.ts';
import { archiveOlderSessions } from './archive.ts';
import type { CcrMultiplexer } from './session.ts';

type DeliveryDeps = {
  mux: CcrMultiplexer;
  // True while the thread's agent is mid-turn — suppresses the premature
  // turn-boundary signal for frames delivered during a turn.
  isThreadBusy(threadId: string): boolean;
  // Bind a thread to its CCR session (create remotely when absent). Returns
  // whether the remote session was created.
  bindThread(threadId: string, title: string, opts?: { recreate?: boolean }): Promise<{ created: boolean }>;
  // Detach a finished thread's session and drop the mirror bookkeeping.
  releaseThread(threadId: string): Promise<void>;
};

async function alreadyDelivered(eventId: string): Promise<boolean> {
  return (await prisma.ccrDelivery.findFirst({ where: { eventId } })) !== null;
}

async function recordDelivery(eventId: string, threadId: string): Promise<void> {
  const row = await prisma.ccrSession.findUnique({ where: { threadId } });

  await prisma.ccrDelivery.create({
    data: { eventId, cseId: row?.cseId ?? 'unknown' },
  });
}

// The status chip of the session in the app's list (external_metadata.
// post_turn_summary — the shape the CLI's own post-turn classifier
// reports; categories: completed | failed | need_input | review_ready).
function firstLine(text: string, max = 160): string {
  return (text.split('\n').find(line => line.trim()) ?? '').trim().slice(0, max);
}

function terminalMetadata(event: Event): Record<string, unknown> {
  if (event.type === 'thread.completed') {
    const summary = event.payload.summary as ThreadSummary | undefined;
    const title = typeof event.payload.title === 'string' ? event.payload.title.trim() : '';
    const description = typeof event.payload.description === 'string' ? event.payload.description.trim() : '';

    return {
      post_turn_summary: {
        status_category: 'completed',
        status_detail: firstLine(title || summary?.text || 'Done'),
        needs_action: '',
        recent_action: '',
        description: description || firstLine(summary?.text ?? '', 300),
      },
    };
  }

  const detail =
    event.type === 'thread.failed'
      ? typeof event.payload.error === 'string'
        ? event.payload.error
        : 'unknown error'
      : `cancelled${typeof event.payload.reason === 'string' ? ` (${event.payload.reason})` : ''}`;

  return {
    post_turn_summary: {
      status_category: 'failed',
      status_detail: firstLine(detail),
      needs_action: '',
      recent_action: '',
    },
  };
}

// The final title of a completed thread (end_thread's correction of the
// start-time guess) — the app's session follows it.
function finalTitle(event: Event): string | null {
  const title =
    event.type === 'thread.completed' && typeof event.payload.title === 'string' ? event.payload.title.trim() : '';

  return title ? title.slice(0, 128) : null;
}

function terminalText(event: Event): string {
  if (event.type === 'thread.completed') {
    const summary = event.payload.summary as ThreadSummary | undefined;
    const fileIds = summary?.fileIds ?? [];
    const fileLines = fileIds.map(fileId => `📎 fileId: ${fileId}`);

    return [`✅ ${summary?.text ?? 'Done.'}`, ...fileLines].join('\n\n');
  }

  if (event.type === 'thread.failed') {
    return `⚠️ The thread failed: ${typeof event.payload.error === 'string' ? event.payload.error : 'unknown'}`;
  }

  const reason = typeof event.payload.reason === 'string' ? event.payload.reason : null;

  return `⛔ The thread was cancelled${reason ? ` (${reason})` : ''}.`;
}

export function startCcrDelivery({ mux, isThreadBusy, bindThread, releaseThread }: DeliveryDeps): Consumer {
  // Birth of a claude-sdk child thread → its own CCR session in the
  // operator's app. Failure to create one is journaled loudly by the
  // consumer machinery: without the binding the whole child conversation
  // has nowhere to go.
  const handleThreadStarted = async (event: Event): Promise<void> => {
    if (!event.targetThreadId || !event.threadId || !event.userId) {
      // A main thread: the coordinator is not a Claude Code session — it
      // lives in the web chat, not in CCR.
      return;
    }

    // A headless thread has no user surface by declaration: no session, and
    // with no ccr_sessions row every later delivery skips it naturally.
    if (event.payload.headless === true) {
      return;
    }

    // The surface is for Claude Code sessions only: the stream tap feeds
    // claude-sdk agents and nothing else (codex threads live in the web).
    const agentName = typeof event.payload.agent === 'string' ? event.payload.agent : '';
    const agent = getAgent(agentName);

    if (agent?.sdk !== 'claude') {
      return;
    }

    if (await alreadyDelivered(event.id)) {
      return;
    }

    const title = typeof event.payload.title === 'string' && event.payload.title ? event.payload.title : 'thread';
    const { created } = await bindThread(event.threadId, title.slice(0, 128));

    if (created) {
      // The declared effort of the session agent, platform default 'high'
      // (mirrors createClaudeSession).
      mux.write(event.threadId, systemInitFrame(process.cwd(), agent.session?.effort ?? 'high'));
    }

    // A fresh spawn is working already: open the app's working indicator.
    mux.reportState(event.threadId, 'running');

    await recordDelivery(event.id, event.threadId);
  };

  // A terminal delivers the summary as the session's final frame and closes
  // the working indicator; the archived session is the readable history.
  // After a process restart the run is gone but the session row remains —
  // re-bind just to deliver the terminal, then release.
  const handleTerminal = async (event: Event): Promise<void> => {
    const threadId = event.threadId;

    if (!threadId) {
      return;
    }

    const row = await prisma.ccrSession.findUnique({ where: { threadId } });

    if (!row) {
      return;
    }

    if (await alreadyDelivered(event.id)) {
      return;
    }

    if (!mux.hasSession(threadId)) {
      try {
        // Terminal delivery only — a deleted session must NOT be recreated
        // just to carry one final frame: the operator already removed the
        // window on purpose.
        await bindThread(threadId, 'thread', { recreate: false });
      } catch (error) {
        if (isSessionGoneError(error)) {
          await recordDelivery(event.id, threadId);
          await prisma.ccrSession.delete({ where: { threadId } }).catch(() => {});

          return;
        }

        throw error;
      }
    }

    // The session takes the thread's final name; a failed rename only costs
    // the operator the old title in the list.
    const title = finalTitle(event);

    if (title) {
      await mux.rename(threadId, title).catch(error => {
        console.error(`[ccr] session rename failed thread=${threadId}:`, error);
      });
    }

    if (!mux.write(threadId, assistantTextFrame(terminalText(event)))) {
      throw new Error(`CCR session for thread ${threadId} is not writable`);
    }

    mux.reportMetadata(threadId, terminalMetadata(event));
    mux.sendResult(threadId);
    mux.reportState(threadId, 'idle');

    await recordDelivery(event.id, threadId);
    await releaseThread(threadId);

    // One more finished session in the list — the oldest beyond the visible
    // window go to the archive. Off the consumer's critical path: a slow
    // sweep must not delay other deliveries.
    void archiveOlderSessions().catch(error => {
      console.error('[ccr] archive sweep failed:', error);
    });
  };

  return startConsumer({
    name: 'ccr-delivery',
    startAtHead: true,
    types: () => ['system.exception', THREAD_NOTIFICATION, THREAD_STARTED, ...TERMINAL_TYPES],
    handler: async event => {
      if (event.type === THREAD_STARTED) {
        return handleThreadStarted(event);
      }

      if (TERMINAL_TYPES.has(event.type)) {
        return handleTerminal(event);
      }

      const threadId = event.threadId;

      if (!threadId || !mux.hasSession(threadId)) {
        return;
      }

      if (await alreadyDelivered(event.id)) {
        return;
      }

      const text =
        event.type === THREAD_NOTIFICATION
          ? typeof event.payload.text === 'string' && event.payload.text
            ? `🔔 ${event.payload.text}`
            : ''
          : `⚠️ system.exception\n\`\`\`json\n${JSON.stringify(event.payload, null, 2).slice(0, 4000)}\n\`\`\``;

      if (!text) {
        return;
      }

      if (!mux.write(threadId, assistantTextFrame(text))) {
        // No live handle right now (re-attach in progress): the failure is
        // journaled and the event skipped — the mirror invariant keeps the
        // meaning in events, not in the frame feed.
        throw new Error(`CCR session for thread ${threadId} is not writable`);
      }

      if (!isThreadBusy(threadId)) {
        mux.sendResult(threadId);
        mux.reportState(threadId, 'idle');
      }

      await recordDelivery(event.id, threadId);
    },
  });
}
