// The SDKMessage tap: the live inner stream of a thread's SDK
// session, published for surface adapters. The CCR plane mirrors these frames
// almost as-is into the operator's Claude app session; the harness knows only
// that observers exist. Listener errors are contained — a surface must never
// break the run.
//
// Next to the frames, the session's end: the harness announces it when it
// closes a thread's session (there is no frame for that), so an observer
// keeping memory per thread (the session journal) knows when to let go.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

type SdkStreamListener = (threadId: string, message: SDKMessage) => void;
type SdkSessionEndListener = (threadId: string) => void;

const listeners = new Set<SdkStreamListener>();
const endListeners = new Set<SdkSessionEndListener>();

export function subscribeSdkStream(listener: SdkStreamListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function emitSdkMessage(threadId: string, message: SDKMessage): void {
  for (const listener of listeners) {
    try {
      listener(threadId, message);
    } catch (error) {
      console.error('[sdk-stream] listener failed:', error);
    }
  }
}

export function subscribeSdkSessionEnd(listener: SdkSessionEndListener): () => void {
  endListeners.add(listener);

  return () => {
    endListeners.delete(listener);
  };
}

export function emitSdkSessionEnd(threadId: string): void {
  for (const listener of endListeners) {
    try {
      listener(threadId);
    } catch (error) {
      console.error('[sdk-stream] end listener failed:', error);
    }
  }
}
