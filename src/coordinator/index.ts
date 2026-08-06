// The coordinator: the agent of the workspace's main thread (§7). Implements
// the run contract statically, inside src/ — dynamic agents cannot replace
// it. Wake cadence is coalescing, the v1 pattern: an inbox event is only a
// wake signal, each turn is built from a fresh transcript snapshot, so any
// number of pending wakes collapse into one turn.

import type { Event } from '../core/contract.ts';
import { appendEvent } from '../core/append.ts';
import { getTranscript } from '../core/events.ts';
import { SYSTEM_EXCEPTION } from '../core/envelope.ts';
import { config } from '../config/index.ts';
import { buildTurnPrompt } from '../harness/openai/prompt-builder.ts';
import { startLlmRequestMetrics } from '../harness/openai/llm-metrics.ts';
import { runTurn } from '../harness/openai/turn.ts';
import { COORDINATOR_INSTRUCTIONS } from './instructions.ts';
import { COORDINATOR_FUNCTION_DEFINITIONS, dispatchCoordinatorFunction } from './functions.ts';

// Raw snapshot window, taken with a margin: the transcript builder selects
// from it by char budget, so the effective depth per event class differs.
const HISTORY_LIMIT = 400;

export type CoordinatorRun = {
  accept: (event: Event) => void;
};

// The volatile counterpart of the static head: the authoritative current
// time, rendered fresh every turn into the prompt's uncached tail. Active
// children join here at stage 3.
function buildStatusText(): string {
  return `[status — authoritative, overrides the transcript]\ntime: ${new Date().toISOString()}`;
}

export function createCoordinatorRun({ threadId, userId }: { threadId: string; userId: string }): CoordinatorRun {
  let wakePending = false;
  let running = false;

  const turn = async (): Promise<void> => {
    const events = await getTranscript(threadId, { last: HISTORY_LIMIT });

    if (!events.length) {
      return;
    }

    const lastSeq = events.at(-1)!.seq;

    const prompt = buildTurnPrompt({
      threadId,
      events,
      lastSeq,
      snapshotFull: events.length >= HISTORY_LIMIT,
      model: config.mainOpenaiModel,
      instructions: COORDINATOR_INSTRUCTIONS,
      tools: COORDINATOR_FUNCTION_DEFINITIONS,
      statusText: buildStatusText(),
    });

    // The new events rendered to nothing — the model has nothing to react
    // to; they will ride along with the next turn's chunk.
    if (!prompt) {
      return;
    }

    const metrics = startLlmRequestMetrics({
      userId,
      threadId,
      lastSeq,
      requestedModel: config.mainOpenaiModel,
    });

    await runTurn({
      model: config.mainOpenaiModel,
      instructions: COORDINATOR_INSTRUCTIONS,
      tools: COORDINATOR_FUNCTION_DEFINITIONS,
      prompt,
      metrics,
      dispatch: call => dispatchCoordinatorFunction(call, { userId, threadId }),
    });
  };

  const loop = async (): Promise<void> => {
    running = true;

    try {
      while (wakePending) {
        wakePending = false;

        try {
          await turn();
        } catch (error) {
          console.error(`[coordinator:${threadId}] turn failed:`, error);

          // A failed turn is journaled into the thread; it does not
          // self-retrigger — the next wake comes from the next event.
          await appendEvent({
            type: SYSTEM_EXCEPTION,
            actor: 'system',
            userId,
            threadId,
            payload: {
              scope: 'coordinator-turn',
              error: error instanceof Error ? error.message : String(error),
            },
          }).catch(appendError => {
            console.error(`[coordinator:${threadId}] failed to journal turn error:`, appendError);
          });
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    accept: () => {
      wakePending = true;

      if (!running) {
        void loop();
      }
    },
  };
}
