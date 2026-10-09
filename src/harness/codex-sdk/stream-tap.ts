// The ThreadEvent tap: the live inner stream of a thread's Codex session,
// published for observers (the session journal). Like the claude-sdk tap,
// the harness knows only that observers exist; listener errors are
// contained — an observer must never break the run.

import type { ThreadEvent } from '@openai/codex-sdk';

type CodexStreamListener = (threadId: string, event: ThreadEvent) => void;

const listeners = new Set<CodexStreamListener>();

export function subscribeCodexStream(listener: CodexStreamListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function emitCodexEvent(threadId: string, event: ThreadEvent): void {
  for (const listener of listeners) {
    try {
      listener(threadId, event);
    } catch (error) {
      console.error('[codex-stream] listener failed:', error);
    }
  }
}
