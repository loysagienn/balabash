// The SDKMessage tap: the live inner stream of a thread's SDK
// session, published for surface adapters. The CCR plane mirrors these frames
// almost as-is into the operator's Claude app session; the harness knows only
// that observers exist. Listener errors are contained — a surface must never
// break the run.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

type SdkStreamListener = (threadId: string, message: SDKMessage) => void;

const listeners = new Set<SdkStreamListener>();

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
