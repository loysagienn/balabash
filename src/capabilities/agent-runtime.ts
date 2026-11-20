// Dynamic agent runs: builds the RunContext and turns an
// AgentDeclaration into a RoutedRun for the thread router. Core behaviour is
// injected through ctx — the agent module never imports runtime
// values from the bundle.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  Event,
  JsonObject,
  RunContext,
  RunResume,
  Thread,
} from '../core/contract.ts';
import { deliverThreadMessage } from '../tree/thread-verbs.ts';
import { appendEvent } from '../core/append.ts';
import { THREAD_COMPLETED, THREAD_FAILED } from '../core/envelope.ts';
import { createClaudeSession } from '../harness/claude-sdk/sdk-session.ts';
import { createCodexSession } from '../harness/codex-sdk/sdk-session.ts';
import type { RoutedRun } from '../runtime/router.ts';
import { getAgent, isRemoteAgent } from './agent-catalog.ts';
import { createSessionRun, withSpawnFiles } from './session-run.ts';

const AGENT_STATE_ROOT = path.resolve('data', 'agent-state');

// Central spawn-input validation: every agent takes the same input — one
// non-empty text prompt.
function validateAgentInput(declarationName: string, input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error(`Invalid input for agent "${declarationName}": the spawn input must be a non-empty prompt string`);
  }

  return input.trim();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Spawns the run for a freshly started child thread (router hook). Returns
// null when the run cannot start; the failure is journaled as the thread's
// terminal, so the parent learns about it the ordinary way. With `resume` the
// run continues the thread's saved SDK session after an app restart
// (resume-runs.ts) — the same run, built from the same thread.started.
export async function spawnAgentRun(thread: Thread, startedEvent: Event, resume?: RunResume): Promise<RoutedRun | null> {
  const failThread = async (error: string) => {
    await appendEvent({
      type: THREAD_FAILED,
      actor: 'system',
      workspaceId: thread.workspaceId,
      threadId: thread.id,
      payload: { error },
    }).catch(appendError => {
      console.error(`[agent-run:${thread.id}] failed to journal spawn failure:`, appendError);
    });
  };

  const declaration = getAgent(thread.agent);

  if (!declaration) {
    await failThread(`Unknown agent "${thread.agent}"`);

    return null;
  }

  // A remote kind's thread is the remote engine's (the router's spawn hook
  // branches on thread.remote); reaching here means the thread was started
  // without the flag.
  if (isRemoteAgent(declaration)) {
    await failThread(`Agent "${thread.agent}" is a remote kind — its thread must be started as remote`);

    return null;
  }

  const { workspaceId } = thread;
  const threadId = thread.id;
  const agentName = declaration.name;
  const abortController = new AbortController();

  const stateDir = path.join(AGENT_STATE_ROOT, agentName, workspaceId);

  await mkdir(stateDir, { recursive: true });

  const ctx: RunContext = {
    headless: thread.headless,
    parentThreadId: thread.parentId,
    threadId,
    workspaceId,
    signal: abortController.signal,

    complete: async (summary, meta) => {
      await appendEvent({
        type: THREAD_COMPLETED,
        actor: 'agent',
        agentName,
        workspaceId,
        threadId,
        payload: {
          summary: summary as unknown as JsonObject,
          ...(meta?.title ? { title: meta.title } : {}),
          ...(meta?.description ? { description: meta.description } : {}),
          ...(meta?.project ? { projectId: meta.project.id, projectSlug: meta.project.slug } : {}),
        },
      });
    },

    deliverTurnText: text => deliverThreadMessage({ caller: { workspaceId, threadId, agentName }, program: null }, text),

    harness: {
      // threadId feeds the stream taps: the session journal (session.*
      // events) observes both SDKs, a surface adapter (CCR) mirrors the raw
      // inner stream of claude-sdk threads.
      sdkSession: options =>
        declaration.sdk === 'codex'
          ? createCodexSession(options, { agent: declaration, workspaceId, cwd: stateDir, threadId })
          : createClaudeSession(options, { agent: declaration, workspaceId, cwd: stateDir, threadId }),
    },

    stateDir,
    ...(resume ? { resume } : {}),
  };

  let run;

  try {
    // The attachments of the spawn prompt are read like a message's: a line
    // per file and the hint how to reach them — the bytes stay in storage.
    const prompt = withSpawnFiles(validateAgentInput(agentName, startedEvent.payload.input), startedEvent.payload.files);
    run = createSessionRun(declaration, prompt, ctx);
  } catch (error) {
    await failThread(getErrorMessage(error));

    return null;
  }

  // Self-termination: a proper agent writes its terminal via ctx.complete()
  // before finishing (or was cancelled — the terminal is already there). A
  // run that just ends, or dies, terminates the thread as failed; the append
  // is a no-op when a terminal already won.
  run.finished.then(
    () => failThread('Run ended without a terminal'),
    error => failThread(getErrorMessage(error)),
  );

  console.log(`[agent-run:${threadId}] ${resume ? 'resumed' : 'started'} agent "${agentName}"`);

  return {
    accept: event => {
      try {
        run.accept(event);
      } catch (error) {
        console.error(`[agent-run:${threadId}] accept failed:`, error);
      }
    },

    abort: reason => {
      abortController.abort(reason);
    },

    interrupt: () => {
      try {
        run.interrupt();
      } catch (error) {
        console.error(`[agent-run:${threadId}] interrupt failed:`, error);
      }
    },
  };
}
