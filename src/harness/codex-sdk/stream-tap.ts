// The ThreadEvent tap: the live inner stream of a thread's Codex session,
// published for observers (the session journal). Like the claude-sdk tap,
// the harness knows only that observers exist; listener errors are
// contained — an observer must never break the run. The session's end is
// announced by the harness when it closes the session (no event carries it).

import type { ThreadEvent } from '@openai/codex-sdk';

type CodexStreamListener = (threadId: string, event: ThreadEvent) => void;
type CodexSessionEndListener = (threadId: string) => void;

const listeners = new Set<CodexStreamListener>();
const endListeners = new Set<CodexSessionEndListener>();

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

export function subscribeCodexSessionEnd(listener: CodexSessionEndListener): () => void {
  endListeners.add(listener);

  return () => {
    endListeners.delete(listener);
  };
}

export function emitCodexSessionEnd(threadId: string): void {
  for (const listener of endListeners) {
    try {
      listener(threadId);
    } catch (error) {
      console.error('[codex-stream] end listener failed:', error);
    }
  }
}
