// CCR adapter composition: the operator's Claude app ("remote sessions") as
// the surface of claude-sdk threads. Every non-headless thread of a
// claude-sdk agent gets its own cse_* session that mirrors the raw SDKMessage
// stream of the inner Claude Code session almost as-is; inbound user frames
// append canonical user.message events into the thread (identity is a
// constant — the operator is one, the ambient CLI login is the trust
// boundary); the Stop button maps to thread.interrupt (a soft stop of the
// turn); a terminal delivers the summary as the final frame — the archived
// session is the readable history.
//
// Deliberately NOT here (operator decision): the
// main thread and non-claude-sdk threads (the OpenAI coordinator, codex) —
// CCR shows Claude Code sessions only; the coordinator is reached through
// the web chat.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { appendEvent } from '../../core/append.ts';
import type { Consumer } from '../../core/consumers.ts';
import type { ContentBlock, JsonObject } from '../../core/contract.ts';
import { SYSTEM_EXCEPTION, THREAD_INTERRUPT } from '../../core/envelope.ts';
import { ensureOperatorWorkspace, getThread } from '../../core/threads.ts';
import { subscribeSdkStream } from '../../harness/claude-sdk/stream-tap.ts';
import { getThreadContextUsage } from '../../harness/claude-sdk/context-usage.ts';
import { resolveOperatorCredentials } from './token.ts';
import { parseInboundUserMessage } from './frames.ts';
import { downloadAttachment } from './attachments.ts';
import { CcrMultiplexer } from './session.ts';
import { startCcrDelivery } from './delivery.ts';

// The one operator behind the ambient login. A constant by design: the CCR
// plane has exactly one human, and the workspace is the trust boundary.
const OPERATOR_IDENTITY: JsonObject = { username: 'operator' };

// Echo suppression bound: pending inbound texts kept per thread while the SDK
// session replays them back through the stream tap.
const MAX_PENDING_ECHOES = 20;

export type CcrAdapter = {
  consumer: Consumer;
  stop(): Promise<void>;
};

// Text of a user frame, for echo matching only (attachments do not echo).
function userFrameText(msg: SDKMessage): string | null {
  return parseInboundUserMessage(msg)?.text ?? null;
}

// The last text block of a mirrored assistant frame, first line only — the
// status chip of a waiting session quotes what the agent said last.
function assistantFrameLine(msg: SDKMessage): string | null {
  if (msg.type !== 'assistant') {
    return null;
  }

  const content = (msg as { message?: { content?: unknown } }).message?.content;
  const blocks = Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>) : [];
  const text = blocks.filter(block => block.type === 'text' && typeof block.text === 'string').at(-1)?.text ?? '';
  const line =
    text
      .split('\n')
      .find(part => part.trim())
      ?.trim() ?? '';

  return line ? line.slice(0, 160) : null;
}

// The session's status chip once the agent yielded the turn: the app lists
// it as waiting for the user, quoting the agent's last words. A turn that
// ended with no text clears the chip.
function waitingMetadata(lastLine: string | null): Record<string, unknown> {
  if (!lastLine) {
    return { post_turn_summary: null };
  }

  return {
    post_turn_summary: { status_category: 'need_input', status_detail: lastLine, needs_action: '', recent_action: '' },
  };
}

export async function startCcrAdapter(): Promise<CcrAdapter> {
  // The singleton channel serves the operator's workspace and nothing else.
  const { userId } = await ensureOperatorWorkspace();

  // The app's working indicator per thread: report transitions only.
  const runningStates = new Map<string, 'running' | 'idle'>();
  // Inbound texts awaiting their replay through the SDK stream: the app
  // already shows what the operator typed — the echo frame is dropped.
  const pendingEchoes = new Map<string, string[]>();
  // The agent's last spoken line per thread, for the status chip.
  const lastAssistantLines = new Map<string, string>();

  const journalException = async (threadId: string, scope: string, error: unknown): Promise<void> => {
    await appendEvent({
      type: SYSTEM_EXCEPTION,
      actor: 'system',
      userId,
      threadId,
      payload: { scope, error: error instanceof Error ? error.message : String(error) },
    }).catch(appendError => {
      console.error(`[ccr] failed to journal exception (${scope}):`, appendError);
    });
  };

  const handleUserMessage = async (threadId: string, msg: SDKMessage): Promise<void> => {
    const inbound = parseInboundUserMessage(msg);

    if (!inbound) {
      return;
    }

    const blocks: ContentBlock[] = [];
    const fileMetas: JsonObject[] = [];

    if (inbound.attachments.length) {
      const creds = await resolveOperatorCredentials();

      for (const attachment of inbound.attachments) {
        try {
          const file = await downloadAttachment(attachment, creds.accessToken, userId);

          blocks.push(attachment.isImage ? { type: 'image', fileId: file.id } : { type: 'file', fileId: file.id });
          fileMetas.push({
            fileId: file.id,
            contentType: file.contentType,
            originalFilename: file.originalFilename,
            sizeBytes: file.sizeBytes,
          });
        } catch (error) {
          console.error(`[ccr] attachment download failed (${attachment.fileName}):`, error);
          await journalException(threadId, 'ccr-attachment', error);
        }
      }
    }

    if (!inbound.text && !blocks.length) {
      return;
    }

    // The session will replay this text through the stream tap — remember
    // it so the echo frame is dropped instead of duplicating what the
    // operator already sees in the app.
    if (inbound.text) {
      const pending = pendingEchoes.get(threadId) ?? [];

      pending.push(inbound.text);
      pendingEchoes.set(threadId, pending.slice(-MAX_PENDING_ECHOES));
    }

    await appendEvent({
      type: 'user.message',
      actor: 'user',
      userId,
      threadId,
      payload: {
        text: inbound.text,
        ...(blocks.length ? { blocks, files: fileMetas } : {}),
        identity: OPERATOR_IDENTITY,
      },
    });
  };

  // Stop → thread.interrupt: a soft stop of the turn in flight. The run stays
  // alive and waits for the operator's next message (the use case: a message
  // sent half-typed, the agent already off on a long job). Ending a thread is
  // never a button here — the operator asks the agent (end_thread) or the
  // coordinator (cancel_thread). The command is addressed from the parent,
  // one hop down, like thread.cancel; the human identity rides in the payload.
  const handleInterrupt = (threadId: string): void => {
    void (async () => {
      const thread = await getThread(threadId);

      if (!thread || thread.status !== 'active' || !thread.parentId) {
        return;
      }

      await appendEvent({
        type: THREAD_INTERRUPT,
        actor: 'user',
        userId,
        threadId: thread.parentId,
        targetThreadId: thread.id,
        payload: { reason: 'interrupted_by_user', identity: OPERATOR_IDENTITY },
      });
    })().catch(error => {
      console.error(`[ccr] interrupt handling failed thread=${threadId}:`, error);
      void journalException(threadId, 'ccr-interrupt', error);
    });
  };

  const mux = new CcrMultiplexer({
    onUserMessage: async (threadId, msg) => {
      try {
        await handleUserMessage(threadId, msg);
      } catch (error) {
        console.error(`[ccr] inbound handling failed thread=${threadId}:`, error);
        await journalException(threadId, 'ccr-inbound', error);
      }
    },
    onInterrupt: handleInterrupt,
    onFatal: (threadId, description) => {
      void journalException(threadId, 'ccr-session', new Error(description));
    },
    // The app's context indicator: the thread's live SDK session computes
    // its own context-window occupancy.
    onGetContextUsage: (threadId, opts) => getThreadContextUsage(threadId, opts),
  });

  // The live mirror: raw SDKMessage frames of claude-sdk threads go into
  // their CCR sessions almost as-is; a result closes the turn.
  const unsubscribeStream = subscribeSdkStream((threadId, message) => {
    if (!mux.hasSession(threadId)) {
      return;
    }

    if (message.type === 'result') {
      mux.sendResult(threadId);
      mux.reportMetadata(threadId, waitingMetadata(lastAssistantLines.get(threadId) ?? null));
      mux.reportState(threadId, 'idle');
      runningStates.set(threadId, 'idle');

      return;
    }

    if (message.type === 'user') {
      const pending = pendingEchoes.get(threadId);
      const text = pending?.length ? userFrameText(message) : null;

      if (text && pending) {
        const index = pending.findIndex(p => text === p || text.endsWith(p));

        if (index >= 0) {
          pending.splice(index, 1);

          return;
        }
      }
    }

    mux.write(threadId, message);

    if (runningStates.get(threadId) !== 'running') {
      runningStates.set(threadId, 'running');
      lastAssistantLines.delete(threadId);
      mux.reportState(threadId, 'running');
      // A new turn: the waiting chip of the previous one is stale.
      mux.reportMetadata(threadId, { post_turn_summary: null });
    }

    // After the turn transition: the first line of a fresh turn must survive
    // the reset above.
    const line = assistantFrameLine(message);

    if (line) {
      lastAssistantLines.set(threadId, line);
    }
  });

  const consumer = startCcrDelivery({
    mux,
    isThreadBusy: threadId => runningStates.get(threadId) === 'running',
    bindThread: (threadId, title, opts) => mux.ensureSession(threadId, title, opts),
    releaseThread: async threadId => {
      runningStates.delete(threadId);
      pendingEchoes.delete(threadId);
      lastAssistantLines.delete(threadId);
      await mux.release(threadId);
    },
  });

  console.log(`[ccr] adapter is running (operator workspace ${userId})`);

  return {
    consumer,
    stop: async () => {
      unsubscribeStream();
      await mux.stop();
    },
  };
}
