// The remote engine: the one driver of every remote thread of the process.
//
// A remote agent is a catalog agent whose session runs in an external
// system (RemoteAgentDeclaration, src/core/contract.ts — the driver
// contract lives there; the kinds come from the installation's extensions,
// src/capabilities/remote-agent-source.ts). Its thread is the MIRROR of
// that session: the agent's replies, tool calls and questions appear in
// the thread as the platform's own events, everything sent into the thread
// reaches the session as the owner's word, and the thread's state follows
// the session's phase. There is no run: nothing in memory beyond a
// per-thread inbox and lock; the row of remote_threads (the session's
// reference, the driver's cursor, the engine's watch — store.ts) is the
// whole state, and the engine resumes from it after a restart — a remote
// thread survives one, is no obstacle to the restart window and is not
// tombstoned at boot (src/core/threads.ts).
//
// The owner is whoever spawned the thread: the secretary's remote thread
// talks to the user (an ordinary thread); another agent's is headless and
// talks to its parent. A remote thread never ends on its own — the session
// is endless and the thread merely pauses when idle. Three different
// words: thread.interrupt stops the turn in flight (the thread waits on);
// thread.cancel closes the thread without touching the session; thread.finish
// asks the session for a closing summary in a turn of text alone, and that
// text completes the thread. The owner's end cancels a headless child (the
// platform's cascade). A question of the agent (agent.ask: an approval, a
// sign-in) needs a human — thread.decide carries the decision; no agent of
// ours decides.
//
// Three sides:
//
// - the facade the router registers for the thread (facade.ts): inbound
//   events, the soft stop, the terminal — forwarded here by threadId;
// - the inbound side: the events delivered to the thread (the user's or the
//   parent's messages, the commands) applied in order per thread, each as
//   a verb of the driver (say, answer, stop, the closing summary);
// - the polling side (the heart, modeled on src/schedule/heart.ts): the
//   rows due for a read, the driver's items mirrored into the thread's
//   journal atomically with the cursor (mirror.ts, store.ts), the phase of
//   the session turned into the thread's state, the pause after a long
//   idle, the backoff of a failing watch (never a state of the thread: one
//   word to the owner, backoff, waiting).
//
// Files cross the boundary only through the driver: an attachment of the
// owner's message is streamed into the session (say), a file of the session
// is fetched by path on an explicit ask (fetchRemoteFile) and stored here —
// the thread never holds a foreign link that needs a login.
//
// One lock per thread serialises its inbound verbs and its reads: both
// rewrite the watch, and a read must not overwrite what an inbound just
// remembered (our own message id, whose echo is next in the stream). The
// process is one; the lock is in memory.

import { randomUUID } from 'node:crypto';
import type { Event, FileRef, JsonObject, NotificationLevel, RemoteDriver, RemoteDriverContext, RemoteRead, Thread } from '../core/contract.ts';
import { appendEvent } from '../core/append.ts';
import type { AppendInput } from '../core/envelope.ts';
import { AGENT_ASK_RESOLVED, SYSTEM_EXCEPTION, THREAD_COMPLETED, THREAD_FAILED, THREAD_MESSAGE } from '../core/envelope.ts';
import { fileContentBlock, messageFile } from '../core/file-blocks.ts';
import { getUserFile } from '../files/index.ts';
import type { RoutedRun } from '../runtime/router.ts';
import { getLoadedRemoteKind } from '../capabilities/remote-agent-source.ts';
import { createRemoteFacade } from './facade.ts';
import { mirrorRead, notification, stateOfPhase } from './mirror.ts';
import { advanceRow, createRow, getRow, initialWatch, listDueRows, rememberOwnMessage, RemoteRowConflict } from './store.ts';
import type { RemotePhase, RemoteRow, RowPatch, WatchState } from './store.ts';

// ---------------------------------------------------------------------------
// Rhythm

export const POLL_INTERVAL_MS = 5_000;
export const READ_TIMEOUT_MS = 60_000;
export const ROWS_PER_PASS = 20;
export const READS_IN_FLIGHT = 4;
// How often a session is read, by its phase.
export const READ_EVERY_MS: Record<Exclude<RemotePhase, 'closed' | 'gone'>, number> = {
  working: 5_000,
  finishing: 5_000,
  idle: 30_000,
  asking: 30_000,
  paused: 15 * 60_000,
};
export const HINT_MIN_MS = 5_000;
export const HINT_MAX_MS = 60 * 60_000;
// Idle this long → paused.
export const PAUSE_AFTER_MS = 30 * 60_000;
// A failing watch: the backoff, and when the owner hears of it.
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
export const WARN_AFTER_MS = 2 * 60 * 60_000;
export const WARN_EVERY_MS = 15 * 60_000;
// The closing summary: what the session is asked, and how long it may take.
export const FINISH_PROMPT =
  'Write a short closing summary of this session for a handoff: what was done, what remains, where the ' +
  'results are (links, paths). Text only — do not run tools or take any action.';
export const FINISH_TIMEOUT_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Dependencies a test replaces: the kinds (their drivers and contexts) and
// the clock.

type Kind = { driver: RemoteDriver; context: RemoteDriverContext; notification: NotificationLevel | undefined };

type EngineDeps = {
  resolveKind(kind: string): Kind | null;
  now(): Date;
  readTimeoutMs: number;
};

const defaultDeps: EngineDeps = {
  resolveKind: kind => {
    const loaded = getLoadedRemoteKind(kind);

    return loaded ? { driver: loaded.declaration.driver, context: loaded.context, notification: loaded.declaration.notification } : null;
  },
  now: () => new Date(),
  readTimeoutMs: READ_TIMEOUT_MS,
};

let deps: EngineDeps = defaultDeps;

export function configureRemoteEngine(overrides: Partial<EngineDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// The per-thread lock and inbox

const locks = new Map<string, Promise<void>>();

async function withLock<T>(threadId: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(resolve => {
    release = resolve;
  });
  const chained = previous.then(() => mine);

  locks.set(threadId, chained);
  await previous;

  try {
    return await work();
  } finally {
    release();

    if (locks.get(threadId) === chained) {
      locks.delete(threadId);
    }
  }
}

function isLocked(threadId: string): boolean {
  return locks.has(threadId);
}

type Inbox = { queue: Event[]; draining: Promise<void> | null; closed: boolean };

const inboxes = new Map<string, Inbox>();
// An open in progress: inbound events of the thread wait for its row.
const pendingOpens = new Map<string, Promise<void>>();

function inboxOf(threadId: string): Inbox {
  let inbox = inboxes.get(threadId);

  if (!inbox) {
    inbox = { queue: [], draining: null, closed: false };
    inboxes.set(threadId, inbox);
  }

  return inbox;
}

function drain(threadId: string, inbox: Inbox): void {
  if (inbox.draining) {
    return;
  }

  inbox.draining = (async () => {
    try {
      while (inbox.queue.length && !inbox.closed) {
        const event = inbox.queue.shift()!;

        try {
          await pendingOpens.get(threadId);
          await withLock(threadId, () => applyInbound(threadId, event));
        } catch (error) {
          console.error(`[remote:${threadId}] inbound ${event.type} failed:`, error);
        }
      }
    } finally {
      inbox.draining = null;
    }
  })();
}

export function inbound(threadId: string, event: Event): void {
  const inbox = inboxOf(threadId);

  if (inbox.closed) {
    return;
  }

  inbox.queue.push(event);
  drain(threadId, inbox);
}

// The thread is over (a terminal was routed): the inbox is closed and
// dropped, the row marked closed; the session is not touched — a cancel
// leaves it as it is, a finish already got its summary.
export function forget(threadId: string, reason: string): void {
  const inbox = inboxes.get(threadId);

  if (inbox) {
    inbox.closed = true;
    inbox.queue.length = 0;
    inboxes.delete(threadId);
  }

  void withLock(threadId, async () => {
    const row = await getRow(threadId);

    if (row && row.phase !== 'closed' && row.phase !== 'gone') {
      await advanceRow(threadId, { phase: 'closed' });
    }
  }).catch(error => {
    console.error(`[remote:${threadId}] closing the row failed:`, error);
  });

  console.log(`[remote:${threadId}] forgotten (${reason})`);
}

// Awaited by tests: every inbox drained, every open done, every lock
// released — and nothing new started meanwhile.
export async function settled(): Promise<void> {
  for (;;) {
    const pending = [...[...inboxes.values()].map(inbox => inbox.draining), ...pendingOpens.values(), ...locks.values()].filter(Boolean);

    if (!pending.length) {
      return;
    }

    await Promise.all(pending);
  }
}

// ---------------------------------------------------------------------------
// Helpers over a row

function kindOf(row: RemoteRow): Kind | null {
  return deps.resolveKind(row.kind);
}

function readEvery(phase: Exclude<RemotePhase, 'closed' | 'gone'>, hintSec: number | undefined): number {
  if (typeof hintSec === 'number' && Number.isFinite(hintSec)) {
    return Math.min(HINT_MAX_MS, Math.max(HINT_MIN_MS, hintSec * 1000));
  }

  return READ_EVERY_MS[phase];
}

function stateEvent(row: Pick<RemoteRow, 'threadId' | 'userId' | 'kind'>, state: WatchState['state']): AppendInput {
  return { type: 'session.state', actor: 'agent', agentName: row.kind, userId: row.userId, threadId: row.threadId, payload: { state } };
}

// The state after a phase, written only when it changes.
function withState(row: Pick<RemoteRow, 'threadId' | 'userId' | 'kind'>, watch: WatchState, phase: Exclude<RemotePhase, 'closed' | 'gone'>, events: AppendInput[]): WatchState {
  const state = stateOfPhase(phase);

  if (watch.state === state) {
    return watch;
  }

  events.push(stateEvent(row, state));

  return { ...watch, state };
}

async function failThread(row: Pick<RemoteRow, 'threadId' | 'userId'>, error: string): Promise<void> {
  await appendEvent({ type: THREAD_FAILED, actor: 'system', userId: row.userId, threadId: row.threadId, payload: { error } }).catch(appendError => {
    console.error(`[remote:${row.threadId}] failed to journal the failure:`, appendError);
  });
}

// ---------------------------------------------------------------------------
// Opening: thread.started of a remote thread — a new session through the
// driver, or an existing one adopted. The row and the opening events
// (session.started, session.state) commit together; a failure is the
// thread's terminal, so the parent learns about it the ordinary way.

export async function openRemoteThread(thread: Thread, started: Event): Promise<RoutedRun | null> {
  const run = (async (): Promise<boolean> => {
    const kind = deps.resolveKind(thread.agent);
    // The row-shaped view of the thread for the helpers below.
    const self = { threadId: thread.id, userId: thread.userId, kind: thread.agent };

    if (!kind) {
      await failThread(self, `remote agent kind "${thread.agent}" is not loaded`);

      return false;
    }

    const payload = started.payload;
    const input = typeof payload.input === 'string' ? payload.input.trim() : '';
    const adopt = payload.adopt === true;
    const options = (payload.options && typeof payload.options === 'object' && !Array.isArray(payload.options) ? payload.options : {}) as JsonObject;
    const notificationLevel = (payload.notification as NotificationLevel | undefined) ?? kind.notification ?? 'normal';
    const base = initialWatch({ headless: thread.headless, parentId: thread.parentId ?? '', notification: notificationLevel });
    const now = deps.now();
    const startedEvent: AppendInput = {
      type: 'session.started',
      actor: 'agent',
      agentName: thread.agent,
      userId: thread.userId,
      threadId: thread.id,
      payload: {
        model: typeof options.model === 'string' && options.model ? options.model : typeof options.harness === 'string' && options.harness ? options.harness : thread.agent,
        effort: typeof options.effort === 'string' ? options.effort : null,
        tools: [],
        mcpServers: [],
      },
    };

    if (!input) {
      await failThread(self, adopt ? 'adopting a remote session needs its reference' : 'a remote session needs a prompt');

      return false;
    }

    try {
      if (adopt) {
        const described = await kind.driver.describe(kind.context, input);

        if (!described.exists) {
          await failThread(self, 'unknown remote session');

          return false;
        }

        await createRow(
          { threadId: thread.id, userId: thread.userId, kind: thread.agent, ref: input, link: described.link ?? null, watch: base, phase: 'idle', lastActivityAt: now, nextPollAt: now },
          [startedEvent],
        );
      } else {
        const opened = await kind.driver.open(kind.context, { prompt: input, options, files: [], messageId: started.id });
        const watch: WatchState = withState(self, rememberOwnMessage(base, started.id), 'working', []);
        const events = [startedEvent, stateEvent(self, 'run')];

        await createRow(
          { threadId: thread.id, userId: thread.userId, kind: thread.agent, ref: opened.ref, link: opened.link ?? null, watch, phase: 'working', lastActivityAt: now, nextPollAt: now },
          events,
        );
      }
    } catch (error) {
      await failThread(self, error instanceof RemoteRowConflict ? 'this session already has a thread' : `the remote session could not be opened: ${getErrorMessage(error)}`);

      return false;
    }

    console.log(`[remote:${thread.id}] ${adopt ? 'adopted' : 'opened'} a session of ${thread.agent}`);

    return true;
  })();

  const pending = run.then(() => undefined, () => undefined);

  pendingOpens.set(thread.id, pending);

  try {
    const opened = await run;

    return opened ? remoteFacade(thread) : null;
  } finally {
    pendingOpens.delete(thread.id);
  }
}

export function remoteFacade(thread: Thread): RoutedRun {
  return createRemoteFacade(thread.id, { inbound, stop, forget });
}

// ---------------------------------------------------------------------------
// Inbound: the events delivered to the thread, each a verb of the driver.

// The attachments of the owner's message — user.message.files, or the
// fileIds of a thread.message — as stored files of the workspace (a foreign
// or missing id is dropped with a word in the log, not a crash of the
// whole message).
async function inboundFiles(event: Event, userId: string): Promise<FileRef[]> {
  const payload = event.payload;
  const ids = new Set<string>();

  for (const file of Array.isArray(payload.files) ? payload.files : []) {
    if (file && typeof file === 'object' && typeof (file as { fileId?: unknown }).fileId === 'string') {
      ids.add((file as { fileId: string }).fileId);
    }
  }

  for (const fileId of Array.isArray(payload.fileIds) ? payload.fileIds : []) {
    if (typeof fileId === 'string') {
      ids.add(fileId);
    }
  }

  const files: FileRef[] = [];

  for (const fileId of ids) {
    try {
      files.push(await getUserFile(userId, fileId));
    } catch (error) {
      console.error(`[remote:${event.threadId ?? event.targetThreadId}] attachment ${fileId} skipped:`, error);
    }
  }

  return files;
}

async function applyInbound(threadId: string, event: Event): Promise<void> {
  const row = await getRow(threadId);

  if (!row || row.phase === 'closed' || row.phase === 'gone') {
    return;
  }

  const kind = kindOf(row);

  if (!kind) {
    console.error(`[remote:${threadId}] inbound ${event.type} dropped: kind "${row.kind}" is not loaded`);

    return;
  }

  // A reply mirrored from the other side (user.message source 'remote') is
  // the session's own — never forwarded back.
  const isOwnerText =
    (event.type === 'user.message' && event.payload.source !== 'remote') || (event.type === THREAD_MESSAGE && event.targetThreadId === threadId);

  if (isOwnerText) {
    await say(row, kind, typeof event.payload.text === 'string' ? event.payload.text : '', await inboundFiles(event, row.userId), event.id);

    return;
  }

  if (event.type === 'thread.decide') {
    await decide(row, kind, event);
  }

  if (event.type === 'thread.finish') {
    await finish(row, kind);
  }

  if (event.type === 'thread.pause') {
    await pause(row);
  }
  // Every other event is none of the session's business.
}

async function say(row: RemoteRow, kind: Kind, text: string, files: FileRef[], messageId: string): Promise<void> {
  if (!text.trim() && !files.length) {
    return;
  }

  if (row.phase === 'finishing') {
    await advanceRow(row.threadId, {}, [notification(row, 'normal', 'The thread is finishing — the message was not passed on.')]);

    return;
  }

  try {
    await kind.driver.say(kind.context, { ref: row.ref, text, files, messageId });
  } catch (error) {
    await advanceRow(row.threadId, {}, [notification(row, 'urgent', `The message could not be passed to the session: ${getErrorMessage(error)}`)]);

    return;
  }

  const now = deps.now();
  const events: AppendInput[] = [];
  const watch = withState(row, rememberOwnMessage(row.watch, messageId), 'working', events);

  await advanceRow(row.threadId, { watch, phase: 'working', lastActivityAt: now, nextPollAt: now }, events);
}

// thread.decide: a human's decision on an open ask → the driver, then
// agent.ask.resolved at once (the driver's ask.closed for it is skipped).
async function decide(row: RemoteRow, kind: Kind, event: Event): Promise<void> {
  const askId = typeof event.payload.askId === 'string' ? event.payload.askId : '';
  const decision = typeof event.payload.decision === 'string' ? event.payload.decision : '';
  const ask = row.watch.openAsks.find(open => open.askId === askId);

  if (!ask || !decision) {
    await advanceRow(row.threadId, {}, [notification(row, 'normal', `No open question "${askId}" to decide.`)]);

    return;
  }

  if (ask.kind === 'credential') {
    await advanceRow(row.threadId, {}, [notification(row, 'normal', 'A sign-in is completed by its link, not by a decision.')]);

    return;
  }

  try {
    await kind.driver.answer(kind.context, { ref: row.ref, askId, decision });
  } catch (error) {
    await advanceRow(row.threadId, {}, [notification(row, 'urgent', `The decision could not be passed to the session: ${getErrorMessage(error)}`)]);

    return;
  }

  const now = deps.now();
  const events: AppendInput[] = [
    {
      type: AGENT_ASK_RESOLVED,
      actor: 'agent',
      agentName: row.kind,
      userId: row.userId,
      threadId: row.threadId,
      payload: {
        askId,
        outcome: decision,
        by: { ...(event.payload.identity ? { identity: event.payload.identity } : {}), ...(typeof event.payload.source === 'string' ? { source: event.payload.source } : {}) },
      },
    },
  ];
  let watch: WatchState = {
    ...row.watch,
    openAsks: row.watch.openAsks.filter(open => open.askId !== askId),
    resolvedAsks: [...row.watch.resolvedAsks, askId].slice(-200),
  };
  const phase: RemotePhase = watch.openAsks.length ? 'asking' : 'working';

  watch = withState(row, watch, phase, events);
  await advanceRow(row.threadId, { watch, phase, lastActivityAt: now, nextPollAt: now }, events);
}

// thread.finish: the session is asked for a closing summary in a turn of
// text alone; its text becomes the thread's summary (the poll completes the
// thread when that turn ends).
async function finish(row: RemoteRow, kind: Kind): Promise<void> {
  if (row.phase === 'finishing') {
    return;
  }

  const messageId = randomUUID();
  const now = deps.now();

  try {
    await kind.driver.say(kind.context, { ref: row.ref, text: FINISH_PROMPT, files: [], messageId });
  } catch (error) {
    await complete(row, `${row.watch.lastTurnText || '(no summary)'}\n\n(summary composed by Balabash: the session could not be asked — ${getErrorMessage(error)})`);

    return;
  }

  const events: AppendInput[] = [];
  const watch = withState(
    row,
    { ...rememberOwnMessage(row.watch, messageId), finish: { messageId, turnId: null, startedAt: now.toISOString() } },
    'finishing',
    events,
  );

  await advanceRow(row.threadId, { watch, phase: 'finishing', lastActivityAt: now, nextPollAt: now }, events);
}

async function complete(row: RemoteRow, text: string): Promise<void> {
  await advanceRow(row.threadId, { phase: 'closed', watch: { ...row.watch, finish: null } }, [
    { type: THREAD_COMPLETED, actor: 'agent', agentName: row.kind, userId: row.userId, threadId: row.threadId, payload: { summary: { text } } },
  ]);
}

async function pause(row: RemoteRow): Promise<void> {
  if (row.phase !== 'idle' && row.phase !== 'asking') {
    return;
  }

  const events: AppendInput[] = [];
  const watch = withState(row, row.watch, 'paused', events);
  const now = deps.now();

  await advanceRow(row.threadId, { watch, phase: 'paused', nextPollAt: new Date(now.getTime() + READ_EVERY_MS.paused) }, events);
}

// A file of the session by path, on an explicit ask of the thread's owner
// (the remote_fetch_file tool): the driver fetches it, the file is stored
// in the workspace and shown in the thread — to the user as an attachment,
// to the parent as a thread.message with it. The caller must be the
// thread's owner: its parent, or the thread itself.
export async function fetchRemoteFile(threadId: string, path: string, caller: { userId: string; threadId: string }): Promise<FileRef> {
  return withLock(threadId, async () => {
    const row = await getRow(threadId);

    if (!row || row.userId !== caller.userId) {
      throw new Error(`Thread ${threadId} is not a remote thread of this workspace`);
    }

    if (row.phase === 'closed' || row.phase === 'gone') {
      throw new Error(`Thread ${threadId} is over`);
    }

    if (caller.threadId !== row.watch.parentId && caller.threadId !== threadId) {
      throw new Error(`Thread ${threadId} is not a child of the calling thread`);
    }

    const kind = kindOf(row);

    if (!kind) {
      throw new Error(`The driver of "${row.kind}" is not loaded`);
    }

    if (!kind.driver.fetchFile) {
      throw new Error(`The driver of "${row.kind}" cannot fetch files`);
    }

    const fetched = await kind.driver.fetchFile(kind.context, { ref: row.ref, path });

    if (!fetched) {
      throw new Error(`The file is not available (the session asleep, or no such path): ${path}`);
    }

    const file = await kind.context.files.ingest({
      body: fetched.body,
      originalFilename: fetched.filename,
      contentType: fetched.contentType ?? null,
      scope: row.kind,
      userId: row.userId,
    });
    const shown: AppendInput = row.watch.headless
      ? {
          type: THREAD_MESSAGE,
          actor: 'agent',
          agentName: row.kind,
          userId: row.userId,
          threadId: row.threadId,
          targetThreadId: row.watch.parentId,
          payload: { text: `[file] ${file.originalFilename ?? file.id} — ${path}`, fileIds: [file.id], files: [messageFile(file)] },
        }
      : {
          type: 'agent.message',
          actor: 'agent',
          agentName: row.kind,
          userId: row.userId,
          threadId: row.threadId,
          payload: { content: [{ type: 'text', text: path }, fileContentBlock(file)] as unknown as JsonObject[] },
        };

    await advanceRow(threadId, {}, [shown]);

    return file;
  });
}

// thread.interrupt: the session's turn in flight is stopped through the
// driver; the thread waits on (the next read shows the turn stopped).
export function stop(threadId: string): void {
  void withLock(threadId, async () => {
    const row = await getRow(threadId);

    if (!row || row.phase === 'closed' || row.phase === 'gone') {
      return;
    }

    const kind = kindOf(row);

    if (!kind) {
      return;
    }

    try {
      await kind.driver.stop(kind.context, row.ref);
      await advanceRow(threadId, { nextPollAt: deps.now() });
    } catch (error) {
      await advanceRow(threadId, {}, [notification(row, 'normal', `The turn could not be stopped: ${getErrorMessage(error)}`)]);
    }
  }).catch(error => {
    console.error(`[remote:${threadId}] stop failed:`, error);
  });
}

// ---------------------------------------------------------------------------
// The heart: the rows due for a read.

const inFlight = new Set<string>();
const complainedKinds = new Set<string>();

async function readWithTimeout(kind: Kind, row: RemoteRow): Promise<RemoteRead> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`read timed out after ${deps.readTimeoutMs} ms`)), deps.readTimeoutMs);
  });

  try {
    return await Promise.race([kind.driver.read(kind.context, { ref: row.ref, cursor: row.cursor }), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function pollRow(row: RemoteRow): Promise<void> {
  const kind = kindOf(row);

  if (!kind) {
    if (!complainedKinds.has(row.kind)) {
      complainedKinds.add(row.kind);
      await appendEvent({
        type: SYSTEM_EXCEPTION,
        actor: 'system',
        userId: null,
        payload: { scope: 'remote-agents', error: `no driver for kind "${row.kind}" — its threads are not watched until the extension loads` },
      }).catch(() => {});
    }

    return;
  }

  let read: RemoteRead;

  try {
    read = await readWithTimeout(kind, row);
  } catch (error) {
    await readFailed(row, getErrorMessage(error));

    return;
  }

  const now = deps.now();
  const mirrored = mirrorRead(read, { threadId: row.threadId, userId: row.userId, kind: row.kind, watch: row.watch, phase: row.phase });
  const events = [...mirrored.events];
  let watch: WatchState = { ...mirrored.watch, failingSince: null, warnedAt: null };

  if (row.watch.warnedAt) {
    events.push(notification(row, 'normal', 'The session is watched again.'));
  }

  if (mirrored.phase === 'gone') {
    events.push({ type: THREAD_FAILED, actor: 'system', userId: row.userId, threadId: row.threadId, payload: { error: 'the remote session is gone' } });
    await advanceRow(row.threadId, { cursor: read.cursor, watch, phase: 'gone', pollFailures: 0 }, events);

    return;
  }

  if (mirrored.finished) {
    await advanceRow(row.threadId, { cursor: read.cursor, watch: { ...watch, finish: null }, phase: 'closed', pollFailures: 0 }, [
      ...events,
      { type: THREAD_COMPLETED, actor: 'agent', agentName: row.kind, userId: row.userId, threadId: row.threadId, payload: { summary: { text: mirrored.finished.text } } },
    ]);

    return;
  }

  // The closing summary that never came: the thread completes with what
  // the session last said.
  if (row.phase === 'finishing' && watch.finish && now.getTime() - new Date(watch.finish.startedAt).getTime() >= FINISH_TIMEOUT_MS) {
    await advanceRow(row.threadId, { cursor: read.cursor, watch: { ...watch, finish: null }, phase: 'closed', pollFailures: 0 }, [
      ...events,
      {
        type: THREAD_COMPLETED,
        actor: 'agent',
        agentName: row.kind,
        userId: row.userId,
        threadId: row.threadId,
        payload: { summary: { text: `${watch.lastTurnText || '(no summary)'}\n\n(summary composed by Balabash: the session did not answer)` } },
      },
    ]);

    return;
  }

  const lastActivityAt = mirrored.activity ? now : row.lastActivityAt;
  let phase: Exclude<RemotePhase, 'closed' | 'gone'> = mirrored.phase;

  // Asleep: idle long enough — or already paused and still quiet.
  if (phase === 'idle' && now.getTime() - lastActivityAt.getTime() >= PAUSE_AFTER_MS) {
    phase = 'paused';
  }

  watch = withState(row, watch, phase, events);

  await advanceRow(
    row.threadId,
    { cursor: read.cursor, watch, phase, pollFailures: 0, lastActivityAt, nextPollAt: new Date(now.getTime() + readEvery(phase, read.nextReadInSec)) },
    events,
  );
}

async function readFailed(row: RemoteRow, error: string): Promise<void> {
  const now = deps.now();
  const failures = row.pollFailures + 1;
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
  const failingSince = row.watch.failingSince ?? now.toISOString();
  const failingFor = now.getTime() - new Date(failingSince).getTime();
  const events: AppendInput[] = [];
  let warnedAt = row.watch.warnedAt;

  console.error(`[remote:${row.threadId}] read failed (${failures}): ${error}`);

  if (failingFor >= WARN_AFTER_MS && (!warnedAt || now.getTime() - new Date(warnedAt).getTime() >= WARN_EVERY_MS)) {
    events.push(notification(row, warnedAt ? 'normal' : 'urgent', `The session cannot be watched: ${error}`));
    warnedAt = now.toISOString();
  }

  await advanceRow(
    row.threadId,
    { watch: { ...row.watch, failingSince, warnedAt }, pollFailures: failures, nextPollAt: new Date(now.getTime() + delay) },
    events,
  );
}

// One pass: the due rows, at most ROWS_PER_PASS, READS_IN_FLIGHT at a time;
// a row under its lock (an inbound verb, an earlier read) waits for the
// next pass.
export async function runRemotePass(): Promise<void> {
  const rows = (await listDueRows(deps.now(), ROWS_PER_PASS)).filter(row => !inFlight.has(row.threadId) && !isLocked(row.threadId));
  const queue = [...rows];

  const worker = async (): Promise<void> => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const { threadId } = row;

      inFlight.add(threadId);

      try {
        await withLock(threadId, () => pollRow(row!));
      } catch (error) {
        console.error(`[remote:${threadId}] poll failed:`, error);
      } finally {
        inFlight.delete(threadId);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(READS_IN_FLIGHT, queue.length) }, worker));
}

export function startRemoteEngine(pollIntervalMs = POLL_INTERVAL_MS): { name: string; stop: () => void } {
  let ticking = false;

  const timer = setInterval(() => {
    if (ticking) {
      return;
    }

    ticking = true;
    runRemotePass()
      .catch(error => {
        console.error('[remote] pass failed:', error);
      })
      .finally(() => {
        ticking = false;
      });
  }, pollIntervalMs);

  console.log('[remote] engine started');

  return {
    name: 'remote-engine',
    stop: () => {
      clearInterval(timer);
    },
  };
}

// What a test may inspect.
export function inboxSize(threadId: string): number {
  return inboxes.get(threadId)?.queue.length ?? 0;
}

