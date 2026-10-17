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
// per-thread lock; the row of remote_threads (the session's reference, the
// driver's cursor, the engine's watch, the inbound position — store.ts) is
// the whole state, and the engine resumes from it after a restart — a
// remote thread survives one, is no obstacle to the restart window and is
// not tombstoned at boot (src/core/threads.ts).
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
// - the facade the router registers for the thread (facade.ts): a wake on
//   a delivered event, the soft stop, the terminal — forwarded here by
//   threadId; the facade carries nothing;
// - the inbound side: the thread's inbound events (the user's or the
//   parent's messages, the commands) read from the log after the row's
//   own position (inboundSeq) and applied in order, each as a verb of the
//   driver (say, answer, the closing summary, the pause) committed in one
//   transaction with the position — a restart replays what was never
//   delivered (the driver's verbs are idempotent by our ids);
// - the polling side (the heart, modeled on src/schedule/heart.ts): the
//   rows due for a read, the driver's items mirrored into the thread's
//   journal atomically with the cursor (mirror.ts, store.ts), the phase of
//   the session turned into the thread's state, the pause after a long
//   idle, the backoff of a failing watch (never a state of the thread: one
//   word to the owner, backoff, waiting).
//
// Two positions in the row, both durable: the cursor over the session (the
// mirror) and inboundSeq over the thread (the verbs). Nothing is trusted
// to memory: a terminal the process never saw (a cancel after a restart, a
// parent's cascade) is found by the thread's status before any read or
// verb; the opening of a session is idempotent on a redelivered
// thread.started (the row already there); a due row is read again under
// its lock before it is acted on.
//
// Files cross the boundary only through the driver: an attachment of the
// owner's message is streamed into the session (say), a file of the session
// is fetched by path on an explicit ask (fetchRemoteFile) and stored here —
// the thread never holds a foreign link that needs a login.
//
// One lock per thread serialises its opening, its inbound verbs and its
// reads: all rewrite the watch, and a read must not overwrite what an
// inbound just remembered (our own message id, whose echo is next in the
// stream). Every verb of the driver is bounded in time: the router hands
// the thread over at once and never waits on the other side.

import { randomUUID } from 'node:crypto';
import type { Event, FileRef, JsonObject, NotificationLevel, RemoteDriver, RemoteDriverContext, RemoteRead, Thread } from '../core/contract.ts';
import { appendEvent } from '../core/append.ts';
import type { AppendInput } from '../core/envelope.ts';
import { AGENT_ASK_RESOLVED, SYSTEM_EXCEPTION, THREAD_COMPLETED, THREAD_DECIDE, THREAD_FAILED, THREAD_FINISH, THREAD_MESSAGE, THREAD_PAUSE } from '../core/envelope.ts';
import { fileContentBlock, messageFile } from '../core/file-blocks.ts';
import { getThread } from '../core/threads.ts';
import { getUserFile } from '../files/index.ts';
import type { RoutedRun } from '../runtime/router.ts';
import { getLoadedRemoteKind } from '../capabilities/remote-agent-source.ts';
import { createRemoteFacade } from './facade.ts';
import { mirrorRead, notification, stateOfPhase } from './mirror.ts';
import { advanceRow, createRow, getRow, initialWatch, listDueRows, listInboundEvents, listLiveRows, rememberOwnMessage, RemoteRowConflict } from './store.ts';
import type { RemotePhase, RemoteRow, RowPatch, WatchState } from './store.ts';

// ---------------------------------------------------------------------------
// Rhythm

export const POLL_INTERVAL_MS = 5_000;
export const READ_TIMEOUT_MS = 60_000;
// Every other verb of the driver (open, describe, say, answer, stop,
// fetchFile) — bounded alike.
export const VERB_TIMEOUT_MS = 60_000;
export const ROWS_PER_PASS = 20;
export const READS_IN_FLIGHT = 4;
export const INBOUND_BATCH = 50;
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
// A row whose kind is not loaded (the extension failed or is gone): looked
// at again this much later, so it never crowds the healthy rows out of a
// pass.
export const UNLOADED_KIND_RETRY_MS = BACKOFF_MAX_MS;
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
  verbTimeoutMs: number;
};

const defaultDeps: EngineDeps = {
  resolveKind: kind => {
    const loaded = getLoadedRemoteKind(kind);

    return loaded ? { driver: loaded.declaration.driver, context: loaded.context, notification: loaded.declaration.notification } : null;
  },
  now: () => new Date(),
  readTimeoutMs: READ_TIMEOUT_MS,
  verbTimeoutMs: VERB_TIMEOUT_MS,
};

let deps: EngineDeps = defaultDeps;

export function configureRemoteEngine(overrides: Partial<EngineDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A verb of the driver, bounded in time.
async function bounded<T>(verb: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${verb} timed out after ${ms} ms`)), ms);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function verb<T>(name: string, work: Promise<T>): Promise<T> {
  return bounded(name, deps.verbTimeoutMs, work);
}

// ---------------------------------------------------------------------------
// The per-thread lock and the wakes

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

// The threads with a wake queued (not yet under their lock): one wake at a
// time per thread is enough — a drain reads everything after the position.
const wakes = new Set<string>();

// An event was delivered to the thread (the facade): serve its inbound
// events after the row's position. Non-blocking.
export function wake(threadId: string): void {
  if (wakes.has(threadId)) {
    return;
  }

  wakes.add(threadId);
  void withLock(threadId, async () => {
    wakes.delete(threadId);
    await serve(threadId, { poll: false });
  }).catch(error => {
    console.error(`[remote:${threadId}] serving the inbound events failed:`, error);
  });
}

// The restart module's question: a verb of a driver in flight, a wake not
// yet served. The state is durable and a replay is safe — but a verb
// half-way through is better finished than repeated.
export function isRemoteEngineBusy(): boolean {
  return locks.size > 0 || wakes.size > 0;
}

// The thread is over (a terminal was routed): the row is marked closed; the
// session is not touched — a cancel leaves it as it is, a finish already
// got its summary. Belt and braces: a terminal the process never routed
// (after a restart) is found by serve() through the thread's status.
export function forget(threadId: string, reason: string): void {
  void withLock(threadId, async () => {
    const row = await getRow(threadId);

    if (row && isLive(row)) {
      await closeRow(row, reason);
    }
  }).catch(error => {
    console.error(`[remote:${threadId}] closing the row failed:`, error);
  });
}

// Awaited by tests: every lock released (wakes and opens run under it) —
// and nothing new started meanwhile.
export async function settled(): Promise<void> {
  for (;;) {
    const pending = [...locks.values()];

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

function isLive(row: RemoteRow): boolean {
  return row.phase !== 'closed' && row.phase !== 'gone';
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

async function closeRow(row: RemoteRow, reason: string): Promise<void> {
  await advanceRow(row.threadId, { phase: 'closed' });
  console.log(`[remote:${row.threadId}] closed (${reason})`);
}

// The thread behind the row is still active — else the row is closed here
// and now (a terminal this process never routed).
async function threadAlive(row: RemoteRow): Promise<boolean> {
  const thread = await getThread(row.threadId);

  if (thread && thread.status === 'active') {
    return true;
  }

  await closeRow(row, thread ? `the thread is ${thread.status}` : 'the thread is gone');

  return false;
}

// What a verb leaves behind: the row's patch and the events written with
// it in one transaction (the inbound position is added by the caller).
type Commit = { patch: RowPatch; events: AppendInput[] };

const nothing: Commit = { patch: {}, events: [] };

function completion(row: RemoteRow, text: string): Commit {
  return {
    patch: { phase: 'closed', watch: { ...row.watch, finish: null } },
    events: [{ type: THREAD_COMPLETED, actor: 'agent', agentName: row.kind, userId: row.userId, threadId: row.threadId, payload: { summary: { text } } }],
  };
}

// ---------------------------------------------------------------------------
// Opening: thread.started of a remote thread — a new session through the
// driver, or an existing one adopted. The router registers the facade at
// once; the opening runs under the thread's lock, off the router (an
// external system that stalls stalls this thread alone). The row and the
// opening events (session.started, session.state) commit together; a
// failure is the thread's terminal, so the parent learns about it the
// ordinary way. Idempotent: a redelivered thread.started finds the row and
// does nothing.

export function openRemoteThread(thread: Thread, started: Event): Promise<RoutedRun | null> {
  void withLock(thread.id, () => openUnderLock(thread, started)).catch(error => {
    console.error(`[remote:${thread.id}] opening failed:`, error);
  });

  return Promise.resolve(remoteFacade(thread));
}

async function openUnderLock(thread: Thread, started: Event): Promise<void> {
  if (await getRow(thread.id)) {
    console.log(`[remote:${thread.id}] already open (thread.started delivered again)`);

    return;
  }

  const current = await getThread(thread.id);

  if (!current || current.status !== 'active') {
    return;
  }

  const kind = deps.resolveKind(thread.agent);
  // The row-shaped view of the thread for the helpers below.
  const self = { threadId: thread.id, userId: thread.userId, kind: thread.agent };

  if (!kind) {
    await failThread(self, `remote agent kind "${thread.agent}" is not loaded`);

    return;
  }

  const payload = started.payload;
  const input = typeof payload.input === 'string' ? payload.input.trim() : '';
  const adopt = payload.adopt === true;
  const options = (payload.options && typeof payload.options === 'object' && !Array.isArray(payload.options) ? payload.options : {}) as JsonObject;
  const notificationLevel = (payload.notification as NotificationLevel | undefined) ?? kind.notification ?? 'normal';
  const base = initialWatch({ headless: thread.headless, parentId: thread.parentId ?? '', notification: notificationLevel });
  const now = deps.now();
  // The session's facts for the thread: the model the options name, and —
  // once the driver has answered — remoteLink, where a human looks at the
  // session in the external system (the rail shows it).
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

    return;
  }

  // The session opened on the other side, for the word of a failure after
  // it (the row could not be written): the owner can adopt it by hand.
  let openedRef: string | null = null;

  try {
    if (adopt) {
      const described = await verb('describe', kind.driver.describe(kind.context, input));

      if (!described.exists) {
        await failThread(self, 'unknown remote session');

        return;
      }

      if (described.link) {
        startedEvent.payload.remoteLink = described.link;
      }

      await createRow(
        {
          threadId: thread.id,
          userId: thread.userId,
          kind: thread.agent,
          ref: input,
          link: described.link ?? null,
          cursor: described.cursor ?? null,
          watch: base,
          phase: 'idle',
          inboundSeq: started.seq,
          lastActivityAt: now,
          nextPollAt: now,
        },
        [startedEvent],
      );
    } else {
      // The attachments of the spawn prompt (thread.started files) cross
      // the boundary like a message's: as stored files for the driver.
      const opened = await verb('open', kind.driver.open(kind.context, { prompt: input, options, files: await inboundFiles(started, thread.userId), messageId: started.id }));

      openedRef = opened.ref;

      if (opened.link) {
        startedEvent.payload.remoteLink = opened.link;
      }

      const watch: WatchState = withState(self, rememberOwnMessage(base, started.id), 'working', []);
      const events = [startedEvent, stateEvent(self, 'run')];

      await createRow(
        {
          threadId: thread.id,
          userId: thread.userId,
          kind: thread.agent,
          ref: opened.ref,
          link: opened.link ?? null,
          watch,
          phase: 'working',
          inboundSeq: started.seq,
          lastActivityAt: now,
          nextPollAt: now,
        },
        events,
      );
    }
  } catch (error) {
    await failThread(
      self,
      error instanceof RemoteRowConflict
        ? `this session already has a thread${error.existingThreadId ? `: ${error.existingThreadId}` : ''}`
        : openedRef
          ? `the remote session ${openedRef} was opened but its thread could not be recorded: ${getErrorMessage(error)}`
          : `the remote session could not be opened: ${getErrorMessage(error)}`,
    );

    return;
  }

  console.log(`[remote:${thread.id}] ${adopt ? 'adopted' : 'opened'} a session of ${thread.agent}`);
}

export function remoteFacade(thread: Thread): RoutedRun {
  return createRemoteFacade(thread.id, { wake, stop, forget });
}

// ---------------------------------------------------------------------------
// Serving a thread under its lock: the row read afresh, the thread's
// status checked, the inbound events after the position applied — and,
// when asked (the heart), the session read if the row is due.

async function serve(threadId: string, { poll }: { poll: boolean }): Promise<void> {
  const row = await getRow(threadId);

  if (!row || !isLive(row) || !(await threadAlive(row))) {
    return;
  }

  const served = await drainInbound(row);

  if (poll && served && isLive(served) && served.nextPollAt.getTime() <= deps.now().getTime()) {
    await pollRow(served);
  }
}

// ---------------------------------------------------------------------------
// Inbound: the events of the thread after the row's position, each a verb
// of the driver, committed with the position. Returns the row as it is
// after the last one (null when the thread closed meanwhile).

async function drainInbound(start: RemoteRow): Promise<RemoteRow | null> {
  let row: RemoteRow | null = start;

  for (;;) {
    if (!row || !isLive(row)) {
      return row;
    }

    const events = await listInboundEvents(row.threadId, row.inboundSeq, INBOUND_BATCH);

    if (!events.length) {
      return row;
    }

    for (const event of events) {
      if (!row || !isLive(row)) {
        return row;
      }

      const kind = kindOf(row);

      if (!kind) {
        // The verbs wait for the extension: the position stays.
        console.error(`[remote:${row.threadId}] inbound ${event.type} waits: kind "${row.kind}" is not loaded`);

        return row;
      }

      const commit = await applyInbound(row, kind, event);

      await advanceRow(row.threadId, { ...commit.patch, inboundSeq: event.seq }, commit.events);
      row = await getRow(row.threadId);
    }

    if (events.length < INBOUND_BATCH) {
      return row;
    }
  }
}

// The attachments of the owner's message — user.message.files, the fileIds
// of a thread.message, or the files of the spawn's thread.started — as
// stored files of the workspace (a foreign or missing id is dropped with a
// word in the log, not a crash of the whole message).
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

async function applyInbound(row: RemoteRow, kind: Kind, event: Event): Promise<Commit> {
  // A reply mirrored from the other side (user.message source 'remote') is
  // the session's own — never forwarded back.
  const isOwnerText =
    (event.type === 'user.message' && event.payload.source !== 'remote') || (event.type === THREAD_MESSAGE && event.targetThreadId === row.threadId);

  if (isOwnerText) {
    return say(row, kind, typeof event.payload.text === 'string' ? event.payload.text : '', await inboundFiles(event, row.userId), event.id);
  }

  switch (event.type) {
    case THREAD_DECIDE:
      return decide(row, kind, event);
    case THREAD_FINISH:
      return finish(row, kind);
    case THREAD_PAUSE:
      return pause(row);
    default:
      // Every other event is none of the session's business.
      return nothing;
  }
}

async function say(row: RemoteRow, kind: Kind, text: string, files: FileRef[], messageId: string): Promise<Commit> {
  if (!text.trim() && !files.length) {
    return nothing;
  }

  if (row.watch.finish) {
    return { patch: {}, events: [notification(row, 'normal', 'The thread is finishing — the message was not passed on.')] };
  }

  try {
    await verb('say', kind.driver.say(kind.context, { ref: row.ref, text, files, messageId }));
  } catch (error) {
    return { patch: {}, events: [notification(row, 'urgent', `The message could not be passed to the session: ${getErrorMessage(error)}`)] };
  }

  const now = deps.now();
  const events: AppendInput[] = [];
  const watch = withState(row, rememberOwnMessage(row.watch, messageId), 'working', events);

  return { patch: { watch, phase: 'working', lastActivityAt: now, nextPollAt: now }, events };
}

// thread.decide: a human's decision on an open ask → the driver, then
// agent.ask.resolved at once (the driver's ask.closed for it is skipped).
async function decide(row: RemoteRow, kind: Kind, event: Event): Promise<Commit> {
  const askId = typeof event.payload.askId === 'string' ? event.payload.askId : '';
  const decision = typeof event.payload.decision === 'string' ? event.payload.decision : '';
  const ask = row.watch.openAsks.find(open => open.askId === askId);

  if (!ask || !decision) {
    return { patch: {}, events: [notification(row, 'normal', `No open question "${askId}" to decide.`)] };
  }

  if (ask.kind === 'credential') {
    return { patch: {}, events: [notification(row, 'normal', 'A sign-in is completed by its link, not by a decision.')] };
  }

  try {
    await verb('answer', kind.driver.answer(kind.context, { ref: row.ref, askId, decision }));
  } catch (error) {
    return { patch: {}, events: [notification(row, 'urgent', `The decision could not be passed to the session: ${getErrorMessage(error)}`)] };
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

  return { patch: { watch, phase, lastActivityAt: now, nextPollAt: now }, events };
}

// thread.finish: the session is asked for a closing summary in a turn of
// text alone; its text becomes the thread's summary (the poll completes the
// thread when that turn ends, or by the deadline). The summary in flight
// lives in watch.finish — the phase follows it, not the other way round.
async function finish(row: RemoteRow, kind: Kind): Promise<Commit> {
  if (row.watch.finish) {
    return nothing;
  }

  const messageId = randomUUID();
  const now = deps.now();

  try {
    await verb('say', kind.driver.say(kind.context, { ref: row.ref, text: FINISH_PROMPT, files: [], messageId }));
  } catch (error) {
    return completion(row, `${row.watch.lastTurnText || '(no summary)'}\n\n(summary composed by Balabash: the session could not be asked — ${getErrorMessage(error)})`);
  }

  const events: AppendInput[] = [];
  const watch = withState(
    row,
    { ...rememberOwnMessage(row.watch, messageId), finish: { messageId, turnId: null, startedAt: now.toISOString() } },
    'finishing',
    events,
  );

  return { patch: { watch, phase: 'finishing', lastActivityAt: now, nextPollAt: now }, events };
}

// thread.pause: the thread sleeps now — only while it waits for a message.
// A working session is stopped, not paused; a question waits for its
// decision; the owner is told when the pause could not be.
async function pause(row: RemoteRow): Promise<Commit> {
  if (row.phase === 'paused') {
    return nothing;
  }

  if (row.phase !== 'idle') {
    const why = row.phase === 'asking' ? 'it waits for a decision' : row.phase === 'finishing' ? 'it is finishing' : 'the session is working — stop the turn first';

    return { patch: {}, events: [notification(row, 'normal', `The thread was not paused: ${why}.`)] };
  }

  const events: AppendInput[] = [];
  const watch = withState(row, row.watch, 'paused', events);
  const now = deps.now();

  return { patch: { watch, phase: 'paused', nextPollAt: new Date(now.getTime() + READ_EVERY_MS.paused) }, events };
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

    if (!isLive(row)) {
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

    const fetched = await verb('fetchFile', kind.driver.fetchFile(kind.context, { ref: row.ref, path }));

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

    if (!row || !isLive(row)) {
      return;
    }

    const kind = kindOf(row);

    if (!kind) {
      return;
    }

    try {
      await verb('stop', kind.driver.stop(kind.context, row.ref));
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

function readWithTimeout(kind: Kind, row: RemoteRow): Promise<RemoteRead> {
  return bounded('read', deps.readTimeoutMs, kind.driver.read(kind.context, { ref: row.ref, cursor: row.cursor }));
}

// The closing summary that never came: the thread completes with what the
// session last said.
function finishOverdue(watch: WatchState, now: Date): boolean {
  return Boolean(watch.finish) && now.getTime() - new Date(watch.finish!.startedAt).getTime() >= FINISH_TIMEOUT_MS;
}

function overdueCompletion(row: RemoteRow, watch: WatchState): Commit {
  return completion({ ...row, watch }, `${watch.lastTurnText || '(no summary)'}\n\n(summary composed by Balabash: the session did not answer)`);
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

    // Out of the way of the healthy rows until then.
    await advanceRow(row.threadId, { nextPollAt: new Date(deps.now().getTime() + UNLOADED_KIND_RETRY_MS) });

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
  const mirrored = mirrorRead(read, { threadId: row.threadId, userId: row.userId, kind: row.kind, watch: row.watch });
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
    const done = completion({ ...row, watch }, mirrored.finished.text);

    await advanceRow(row.threadId, { cursor: read.cursor, pollFailures: 0, ...done.patch }, [...events, ...done.events]);

    return;
  }

  if (finishOverdue(watch, now)) {
    const done = overdueCompletion(row, watch);

    await advanceRow(row.threadId, { cursor: read.cursor, pollFailures: 0, ...done.patch }, [...events, ...done.events]);

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

  console.error(`[remote:${row.threadId}] read failed (${row.pollFailures + 1}): ${error}`);

  // A finish does not wait on a failing watch past its deadline.
  if (finishOverdue(row.watch, now)) {
    const done = overdueCompletion(row, row.watch);

    await advanceRow(row.threadId, done.patch, done.events);

    return;
  }

  const failures = row.pollFailures + 1;
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
  const failingSince = row.watch.failingSince ?? now.toISOString();
  const failingFor = now.getTime() - new Date(failingSince).getTime();
  const events: AppendInput[] = [];
  let warnedAt = row.watch.warnedAt;

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
// next pass. The list is a candidate list: the row is read again under
// its lock (serve) — what an inbound verb or a terminal did meanwhile is
// not overwritten, and a row no longer due is left alone.
export async function runRemotePass(): Promise<void> {
  const rows = (await listDueRows(deps.now(), ROWS_PER_PASS)).filter(row => !inFlight.has(row.threadId) && !isLocked(row.threadId));
  const queue = rows.map(row => row.threadId);

  const worker = async (): Promise<void> => {
    for (let threadId = queue.shift(); threadId; threadId = queue.shift()) {
      inFlight.add(threadId);

      try {
        await withLock(threadId, () => serve(threadId!, { poll: true }));
      } catch (error) {
        console.error(`[remote:${threadId}] poll failed:`, error);
      } finally {
        inFlight.delete(threadId);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(READS_IN_FLIGHT, queue.length) }, worker));
}

// The boot sweep: every live row woken once — the inbound events a dead
// process had acknowledged in the router but never applied are served now,
// not at the row's next read.
export async function sweepRemoteThreads(): Promise<number> {
  const rows = await listLiveRows();

  for (const row of rows) {
    wake(row.threadId);
  }

  return rows.length;
}

export function startRemoteEngine(pollIntervalMs = POLL_INTERVAL_MS): { name: string; stop: () => void } {
  let ticking = false;

  sweepRemoteThreads()
    .then(count => {
      if (count) {
        console.log(`[remote] boot sweep: ${count} live thread(s) woken`);
      }
    })
    .catch(error => {
      console.error('[remote] boot sweep failed:', error);
    });

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
