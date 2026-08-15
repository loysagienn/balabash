// The coordinator: the agent of the workspace's main thread (§7). Implements
// the run contract statically, inside src/ — dynamic agents cannot replace
// it. Wake cadence is coalescing, the v1 pattern: an inbox event is only a
// wake signal, each turn is built from a fresh transcript snapshot, so any
// number of pending wakes collapse into one turn.

import type { Event, Thread } from '../core/contract.ts';
import { appendEvent } from '../core/append.ts';
import { getTranscript } from '../core/events.ts';
import { SYSTEM_EXCEPTION } from '../core/envelope.ts';
import { listThreads } from '../core/threads.ts';
import { config } from '../config/index.ts';
import { listProjects } from '../projects/store.ts';
import type { ProjectModel } from '../projects/store.ts';
import { getPendingRestart } from '../runtime/restart.ts';
import { buildTurnPrompt } from '../harness/openai/prompt-builder.ts';
import { startLlmRequestMetrics } from '../harness/openai/llm-metrics.ts';
import { runTurn } from '../harness/openai/turn.ts';
import { COORDINATOR_INSTRUCTIONS } from './instructions.ts';
import { getCoordinatorFunctionDefinitions, dispatchCoordinatorFunction } from './functions.ts';

// Raw snapshot window, taken with a margin: the transcript builder selects
// from it by char budget, so the effective depth per event class differs.
const HISTORY_LIMIT = 400;

export type CoordinatorRun = {
  accept: (event: Event) => void;
};

// Coordinator turns in flight, process-wide — the restart module's busy
// check: a wake increments synchronously (accept → loop before the first
// await), so "no turn and 20s of log quiet" cannot race a fresh wake.
let activeTurns = 0;

export function hasActiveCoordinatorTurns(): boolean {
  return activeTurns > 0;
}

// The volatile counterpart of the static head: the authoritative current
// time and the active child threads, rendered fresh every turn into the
// prompt's uncached tail (§8.1). Current run state lives here, not in the
// function definitions — spawns must not reset the cache head. Direct
// children only: grandchildren are invisible by construction (§5.2).
// Exported for offline rendering (scripts/render-context.ts).
export function buildStatusText(children: Thread[], projects: ProjectModel[]): string {
  const lines = [`[status — authoritative, overrides the transcript]`, `time: ${new Date().toISOString()}`];
  const pendingRestart = getPendingRestart();

  if (pendingRestart) {
    lines.push(
      `restart pending: requested ${pendingRestart.requestedAt.toISOString()} (${pendingRestart.reason}) — happens once every child thread is closed and the log goes quiet; avoid starting new threads`,
    );
  }

  if (children.length) {
    lines.push('active child threads:');

    for (const child of children) {
      lines.push(
        `- threadId=${child.id} agent=${child.agent}${child.title ? ` title=${JSON.stringify(child.title)}` : ''} started=${child.createdAt.toISOString()}`,
      );
    }
  } else {
    lines.push('active child threads: (none)');
  }

  // The live projects, most recently touched first — the showcase the
  // secretary matches conversations against (archived ones stay behind
  // projects_list).
  if (projects.length) {
    lines.push('projects:');

    for (const project of projects) {
      lines.push(`- slug=${project.slug} title=${JSON.stringify(project.title)} description=${JSON.stringify(project.description)}`);
    }
  } else {
    lines.push('projects: (none)');
  }

  return lines.join('\n');
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
    const tools = await getCoordinatorFunctionDefinitions(userId);
    const children = await listThreads(userId, { status: 'active', parentId: threadId });
    const projects = await listProjects(userId, { archived: false });

    const prompt = buildTurnPrompt({
      threadId,
      events,
      lastSeq,
      snapshotFull: events.length >= HISTORY_LIMIT,
      model: config.mainOpenaiModel,
      instructions: COORDINATOR_INSTRUCTIONS,
      tools,
      statusText: buildStatusText(children, projects),
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
      tools,
      prompt,
      metrics,
      dispatch: call => dispatchCoordinatorFunction(call, { userId, threadId }),
    });
  };

  const loop = async (): Promise<void> => {
    running = true;
    activeTurns += 1;

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
      activeTurns -= 1;
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
