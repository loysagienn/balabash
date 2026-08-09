// The one journaling point of tool.call.* (§4.3): observational, beside the
// result path. started before the call; completed with the result VERBATIM —
// isError included ("the tool answered, albeit with an error"); failed only
// for breakage of the call itself (a thrown transport/auth/unknown-tool
// error), which is rethrown to the caller. Both model loops — the
// coordinator's function dispatch and the SDK runs' ToolsApi — go through
// here.

import type { JsonObject } from '../core/contract.ts';
import { appendEvent } from '../core/append.ts';
import type { ServerToolOutcome } from './tool-manager.ts';

export type ToolCallJournalContext = {
  userId: string;
  threadId: string;
  agentName: string;
};

export async function callToolJournaled(
  ctx: ToolCallJournalContext,
  callId: string,
  functionName: string,
  args: JsonObject,
  invoke: () => Promise<ServerToolOutcome>,
): Promise<ServerToolOutcome> {
  const journal = async (type: string, payload: JsonObject) => {
    await appendEvent({
      type,
      actor: 'agent',
      agentName: ctx.agentName,
      userId: ctx.userId,
      threadId: ctx.threadId,
      payload,
    });
  };

  await journal('tool.call.started', { callId, functionName, input: args });

  try {
    const outcome = await invoke();

    await journal('tool.call.completed', {
      callId,
      functionName,
      serverName: outcome.serverName,
      toolName: outcome.toolName,
      result: outcome.result as unknown as JsonObject,
    });

    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await journal('tool.call.failed', { callId, functionName, error: message });

    throw error;
  }
}
