// The declarative session runner: turns an AgentDeclaration's `session` spec
// into an AgentRun. This is the platform half of "an agent is a declaration"
// — everything the four original session agents used to copy by hand lives
// here once: the SDK session lifecycle, rendering of incoming events into
// session messages, channel binding (user-facing thread vs headless parent
// dialogue), the end-of-turn report and abort handling.

import { mkdirSync } from 'node:fs';
import { SESSION_RESUMED_IDLE_NOTE, SESSION_RESUMED_INTERRUPTED_NOTE } from '../../agents/world/index.ts';
import { workspaceDbPath } from '../workspace/layout.ts';
import { dropReport, reportLeft, takeReport } from '../core/thread-end.ts';
import { describeFinishRequest } from './thread-verbs.ts';
import type {
  AgentDeclaration,
  AgentRun,
  AgentSdkSession,
  Event,
  RunContext,
  SessionEnvironment,
} from '../core/contract.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Incoming event rendering: how the log's events read inside the session.

// "Who speaks" prefix: the workspace is multi-voice. The user's own name
// (identity.displayName, the same from every channel — one person, one
// voice) with the channel's username.
function speakerOf(payload: Record<string, unknown>): string | null {
  const identity = isObject(payload.identity) ? payload.identity : {};
  const name = typeof identity.displayName === 'string' ? identity.displayName.trim() : '';
  const username = typeof identity.username === 'string' && identity.username ? `@${identity.username}` : null;

  if (name && username) {
    return `${name} (${username})`;
  }

  return name || username;
}

// A file's size as a person reads it: "820 B", "48 KB", "2.1 MB", "1.4 GB".
function readableSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return unit === 0 ? `${value} B` : `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// Attached files as the session reads them: a line per file (the facts the
// sender recorded, `who` names the sender) as stored.
// The catalog supplies its own file guide.
function describeFiles(files: unknown[], who: string): string[] {
  const parts: string[] = [];

  for (const file of files) {
    const meta = isObject(file) ? file : {};

    parts.push(
      `[${who} a file: fileId=${typeof meta.fileId === 'string' ? meta.fileId : 'unknown'}${
        typeof meta.originalFilename === 'string' ? `, name=${meta.originalFilename}` : ''
      }${typeof meta.contentType === 'string' ? `, type=${meta.contentType}` : ''}${
        typeof meta.sizeBytes === 'number' ? `, size=${readableSize(meta.sizeBytes)}` : ''
      }]`,
    );
  }

  return parts;
}

// A user message as the session reads it: the text, then the attached files.
function describeUserMessage(payload: Record<string, unknown>): string {
  const speaker = speakerOf(payload);
  const text = typeof payload.text === 'string' ? payload.text : '';
  const files = Array.isArray(payload.files) ? payload.files : [];
  const parts: string[] = [];

  if (text) {
    parts.push(speaker ? `${speaker}: ${text}` : text);
  }

  return [...parts, ...describeFiles(files, 'the user sent')].join('\n');
}

// The spawn prompt with the attachments of thread.started (payload.files)
// read like a message's: the spawner — the operator of the thread — attached
// them. The runtime supplies this text as the spawn prompt.
export function withSpawnFiles(prompt: string, files: unknown): string {
  return [prompt, ...describeFiles(Array.isArray(files) ? files : [], 'the operator attached')].join('\n');
}

// An incoming thread.message: text plus attached file references. From the
// parent it is the operator speaking (labeled in a user-facing thread, where the
// operator is distinct from the user; plain in a headless thread, where the
// operator's instructions are the only dialogue); a child's reply is labeled with its threadId.
function describeThreadMessage(
  event: Event,
  headless: boolean,
  parentThreadId: string | null,
): string {
  const payload = isObject(event.payload) ? event.payload : {};
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const fileIds = Array.isArray(payload.fileIds)
    ? payload.fileIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
    : [];

  if (event.threadId && event.threadId !== parentThreadId) {
    return [
      ...(text ? [`[Reply from child thread ${event.threadId}]\n${text}`] : []),
      ...fileIds.map(fileId => `[the child attached a file: fileId=${fileId}]`),
    ].join('\n');
  }

  return [
    ...(text ? [headless ? text : `[Message from your operator — not from the user]\n${text}`] : []),
    ...fileIds.map(fileId => `[the operator attached a file: fileId=${fileId}]`),
  ].join('\n');
}

// Events fanned into the run besides the dialogue: lifecycle of this thread's
// own children, redirected facts, domain events.
function describeEvent(event: Event): string {
  return `[Balabash event]\ntype: ${event.type}\npayload: ${JSON.stringify(event.payload)}`;
}

// ---------------------------------------------------------------------------
export function createSessionRun(
  declaration: AgentDeclaration,
  prompt: string,
  ctx: RunContext,
): AgentRun {
  const spec = declaration.session;
  const headless = ctx.headless;
  let settled = false;
  let resolveFinished: () => void;
  let rejectFinished: (error: unknown) => void;

  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  // Resolve the session working directory: a function form is per-workspace (e.g.
  // a workbench under data/workspace/<workspaceId>/...) and is resolved here, at
  // run start. The resolved directory must exist before the SDK session
  // starts in it.
  const cwd = typeof spec.cwd === 'function' ? spec.cwd(ctx.workspaceId) : spec.cwd;

  if (cwd) {
    mkdirSync(cwd, { recursive: true });
  }

  // The session exists only after the declaration's environment (if any) is
  // up: its tools are part of the session's tool set. Text routed in
  // before that is queued and flushed into the session once it exists.
  let session: AgentSdkSession | null = null;
  const preSessionInbox: string[] = [];

  // The message the session opens with. A fresh run: the spawn prompt. A run
  // resumed after an app restart: the restart note — at once when a turn was
  // cut off; otherwise the run stays dormant (no session, no environment)
  // until the first message arrives, which then rides behind the note.
  let wakeDormant: ((text: string) => void) | null = null;
  const opening: Promise<string> = !ctx.resume
    ? Promise.resolve(spec.initialMessage ? spec.initialMessage(prompt) : prompt)
    : ctx.resume.interrupted
      ? Promise.resolve(SESSION_RESUMED_INTERRUPTED_NOTE)
      : new Promise(resolve => {
          wakeDormant = text => resolve(`${SESSION_RESUMED_IDLE_NOTE}\n\n${text}`);
        });

  const pushText = (text: string): void => {
    if (wakeDormant) {
      const wake = wakeDormant;

      wakeDormant = null;
      wake(text);

      return;
    }

    if (!session) {
      preSessionInbox.push(text);

      return;
    }

    try {
      session.push(text);
    } catch {
      // The session may be closing; the run terminal covers the outcome.
    }
  };

  const startSession = (environment: SessionEnvironment | null, initialMessage: string): AgentSdkSession =>
    ctx.harness.sdkSession({
      instructions: environment?.instructions ? `${spec.instructions}\n\n${environment.instructions}` : spec.instructions,
      // The platform default session-opening message is the spawn prompt
      // verbatim; a declaration overrides it only for a different opening move.
      initialMessage,
      ...(ctx.resume ? { resume: ctx.resume.sdkSessionId } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.preset ? { preset: spec.preset } : {}),
      ...(spec.artifacts ? { artifacts: true } : {}),
      ...(spec.imageGeneration ? { imageGeneration: true } : {}),
      ...(cwd ? { cwd } : {}),
      // Scripts run from the session reach the workspace database the same way
      // workspace command children do: via the WORKSPACE_DB env variable.
      env: { WORKSPACE_DB: workspaceDbPath(ctx.workspaceId) },
      environmentTools: environment?.environmentTools,
    });

  const stop = (error?: unknown) => {
    if (settled) {
      return;
    }

    settled = true;
    // A report the thread left and nobody took — the run is over some other
    // way — is nobody's to take any more.
    dropReport(ctx.threadId);
    session?.close();
    // A dormant resumed run cancelled before anything woke it: release the
    // start sequence waiting on its opening.
    wakeDormant?.('');

    if (error === undefined) {
      resolveFinished();
    } else {
      rejectFinished(error);
    }
  };

  // External cancellation (/cancel, cancel_thread, cascade): the terminal is
  // already written; just shut the session down.
  ctx.signal.addEventListener('abort', () => stop(), { once: true });

  void (async () => {
    let environment: SessionEnvironment | null = null;

    try {
      const initialMessage = await opening;

      if (settled) {
        return;
      }

      if (spec.environment) {
        environment = await spec.environment(ctx, cwd ?? ctx.stateDir);
      }

      // Cancelled while the environment was starting: the terminal is
      // already written; the environment is disposed below.
      if (settled) {
        return;
      }

      const created = startSession(environment, initialMessage);

      session = created;

      for (const text of preSessionInbox.splice(0)) {
        created.push(text);
      }

      for await (const turn of created.turns) {
        if (settled) {
          return;
        }

        // A turn cut by Stop: the thread stays open for the next message,
        // and a report left in the cut turn goes with the turn — a thread
        // ends by a turn that ran its course.
        if (turn.interrupted) {
          dropReport(ctx.threadId);

          continue;
        }

        // The report left by end_thread during this turn.
        // The summary carries the report to the operator; the text said
        // after it is the goodbye — meaningful in a user-facing thread (the
        // user reads it), redundant in a headless thread (the parent gets
        // the summary).
        if (turn.text && !(headless && reportLeft(ctx.threadId) !== null)) {
          await ctx.deliverTurnText(turn.text);
        }

        // A text said on the way: the turn goes on, and the thread with it.
        if (turn.ongoing) {
          continue;
        }

        const report = takeReport(ctx.threadId);

        if (report !== null) {
          await ctx.complete(report.summary, {
            title: report.title,
            description: report.description,
            ...(report.project ? { project: report.project } : {}),
          });
          stop();

          return;
        }
      }

      // The stream only ends after close(); reaching here without one is an
      // inner-session failure.
      stop(settled ? undefined : new Error(`${declaration.name} session ended before end_thread was called`));
    } catch (error) {
      stop(error);
    } finally {
      // The environment outlives the session by exactly this step: whatever
      // ended the run (end_thread, abort, a failed turn, a failed start),
      // its machinery is torn down here.
      await environment?.dispose?.().catch(() => {});
    }
  })();

  return {
    // Soft stop (thread.interrupt — a surface's Stop button): cut the turn in
    // flight, keep the session open for the next message. The interrupted
    // turn closes through `turns` with empty text, so nothing is delivered,
    // and a report left in it is dropped: the thread stays open.
    interrupt: () => {
      if (settled || !session?.interrupt) {
        return;
      }

      void session.interrupt();
    },

    accept: (event: Event) => {
      if (settled) {
        return;
      }

      const payload = isObject(event.payload) ? event.payload : {};

      if (event.type === 'user.message') {
        const text = describeUserMessage(payload);

        if (text) {
          pushText(text);
        }

        return;
      }

      if (event.type === 'thread.message') {
        const text = describeThreadMessage(event, headless, ctx.parentThreadId);

        if (text) {
          pushText(text);
        }

        return;
      }

      // thread.finish: the user's or the operator's request to wrap up —
      // the agent ends the thread itself, with its report.
      if (event.type === 'thread.finish') {
        pushText(describeFinishRequest(event));

        return;
      }

      pushText(describeEvent(event));
    },
    finished,
  };
}
