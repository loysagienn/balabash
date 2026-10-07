// Context-usage providers of live SDK sessions, by thread: the inner CLI of a
// thread's session computes the context-window occupancy on request
// (Query.getContextUsage), and a surface adapter may ask for it — the CCR
// plane answers the app's `get_context_usage` control request with it. Like
// the stream tap, the registry is the harness's only knowledge of observers.

import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';

export type ContextUsageOptions = { detail?: 'summary' | 'full' };
export type ContextUsageProvider = (opts: ContextUsageOptions) => Promise<SDKControlGetContextUsageResponse>;

const providers = new Map<string, ContextUsageProvider>();

// Register the provider of a thread's live session. Returns the unregister
// function; it removes only this registration, so a successor session of
// the same thread (a successor run of the same thread) is never unregistered by
// its predecessor's late close.
export function registerContextUsageProvider(threadId: string, provider: ContextUsageProvider): () => void {
  providers.set(threadId, provider);

  return () => {
    if (providers.get(threadId) === provider) {
      providers.delete(threadId);
    }
  };
}

// The context-window occupancy of a thread's live session; rejects when the
// thread has no live SDK session right now.
export async function getThreadContextUsage(
  threadId: string,
  opts: ContextUsageOptions = {},
): Promise<SDKControlGetContextUsageResponse> {
  const provider = providers.get(threadId);

  if (!provider) {
    throw new Error(`thread ${threadId} has no live SDK session to report context usage`);
  }

  return provider(opts);
}
