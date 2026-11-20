// The verbs of a thread, capabilities of the root: what a thread says to
// whoever it talks to and how it ends (`send_message`, `end_thread`), and
// how it operates its children (`spawn_agent`, `send_to_thread`,
// `finish_thread`, `cancel_thread`, `fetch_thread_file`).
//
// A verb is an event of the log written on behalf of the calling thread; the
// log's own rules (src/core/append.ts) hold whatever the action checked
// before — one hop between threads, one terminal per thread — and the
// action turns their refusals into the errors of a call. What follows an
// event is the app's: the router starts the run of a child and delivers the
// messages, the surfaces show a message to the user, the remote engine
// speaks to an external session.
//
// A call made from a program leaves its origin in what it writes
// (`program`: the id of the run and, for a program of the schedule, the
// slug of the task): a message or a child thread of the main thread that no
// turn of the secretary produced can be told from one that a turn did.
//
// Two things here are read from the agents' declarations until the scheme
// of grants says them itself: who a thread may start (the main thread — any
// agent of the catalog; another thread — what the declaration of its agent
// names) and the mode a child runs in (an agent of the repository — the one
// mode it declares; a remote agent — either, by default the one the
// spawner implies: a child of the main thread talks to the user, a child of
// any other thread to its parent).

import { z } from 'zod';
import { CapabilityError, FileId, FileRef, JsonObject, capability, type CallContext, type Caller } from '../catalog/index.ts';
import { getAgent, getAgents, isRemoteAgent, mayAgentSpawn, type CatalogAgent } from '../capabilities/agent-catalog.ts';
import { appendEvent, type AppendResult } from '../core/append.ts';
import type { ContentBlock, FileRef as StoredFile, JsonObject as Json, RemoteAgentDeclaration, Thread } from '../core/contract.ts';
import { AppendError, THREAD_CANCEL, THREAD_FINISH, THREAD_MESSAGE, type AppendInput } from '../core/envelope.ts';
import type { ProgramOrigin } from '../core/event-types.ts';
import { fileContentBlock, messageFile } from '../core/file-blocks.ts';
import { leaveReport } from '../core/thread-end.ts';
import { getThread, startThread } from '../core/threads.ts';
import { getProjectBySlug } from '../projects/store.ts';
import { RemoteFileError, fetchRemoteFile, type RemoteFileRefusal } from '../remote/engine.ts';
import { fileRefValue, storedFile } from './files.ts';

// The thread a call is made on behalf of.
async function callingThread(caller: Caller): Promise<Thread> {
  const thread = await getThread(caller.threadId);

  if (!thread || thread.workspaceId !== caller.workspaceId) {
    throw new CapabilityError('internal', `The calling thread "${caller.threadId}" is not a thread of the workspace.`);
  }

  return thread;
}

// A thread of the caller's workspace an input names; a thread of another
// workspace answers the same as a missing one.
async function workspaceThread(caller: Caller, threadId: string): Promise<Thread> {
  const thread = await getThread(threadId);

  if (!thread || thread.workspaceId !== caller.workspaceId) {
    throw new CapabilityError('not_found', `There is no thread "${threadId}" in the workspace.`);
  }

  return thread;
}

function endedThread(thread: Thread): CapabilityError {
  return new CapabilityError('conflict', `The thread "${thread.id}" has already ended (${thread.status}).`);
}

// A child of the calling thread that is still at work: the only thread the
// verbs of a child thread act on.
async function activeChild(caller: Caller, threadId: string): Promise<Thread> {
  const thread = await workspaceThread(caller, threadId);

  if (thread.parentId !== caller.threadId) {
    throw new CapabilityError(
      'invalid_input',
      `The thread "${threadId}" is not a child of this thread: you operate only the threads you started.`,
    );
  }

  if (thread.status !== 'active') {
    throw endedThread(thread);
  }

  return thread;
}

// The stored files an input names, each once, in the order given.
async function storedFiles(caller: Caller, fileIds: string[] | undefined): Promise<StoredFile[]> {
  const files: StoredFile[] = [];

  for (const fileId of new Set(fileIds ?? [])) {
    files.push(await storedFile(caller, fileId));
  }

  return files;
}

// A text field that has to say something.
function said(field: string, value: string): string {
  const text = value.trim();

  if (!text) {
    throw new CapabilityError('invalid_input', `${field} is blank: it has to say something.`);
  }

  return text;
}

// A project of the caller's workspace by the slug an input names.
async function namedProject(caller: Caller, slug: string | undefined): Promise<{ id: string; slug: string } | undefined> {
  if (slug === undefined) {
    return undefined;
  }

  const project = await getProjectBySlug(caller.workspaceId, slug.trim());

  if (!project) {
    throw new CapabilityError('not_found', `There is no project with the slug "${slug}" in the workspace.`);
  }

  return { id: project.id, slug: project.slug };
}

// Where a call made from a program says so in what it writes.
function programOf(ctx: CallContext): ProgramOrigin | null {
  return ctx.program ? { runId: ctx.program.runId, ...(ctx.program.task ? { task: ctx.program.task } : {}) } : null;
}

function withOrigin(payload: Json, ctx: CallContext): Json {
  const program = programOf(ctx);

  return program ? { ...payload, program } : payload;
}

// What the log's rules refuse, as the error of a call. The actions check
// the same before they write; a refusal here is the same answer for a
// thread that changed in between.
function logRefusal(error: unknown): unknown {
  if (!(error instanceof AppendError)) {
    return error;
  }

  switch (error.code) {
    case 'one_hop':
      return new CapabilityError('invalid_input', 'The thread is not a child of this thread: you operate only the threads you started.');
    case 'target_not_found':
    case 'workspace_mismatch':
      return new CapabilityError('not_found', 'There is no such thread in the workspace.');
    case 'parent_terminated':
      return new CapabilityError('conflict', 'This thread has already ended: it starts no child.');
    default:
      return error;
  }
}

async function write(input: AppendInput): Promise<AppendResult> {
  try {
    return await appendEvent(input);
  } catch (error) {
    throw logRefusal(error);
  }
}

// --- The thread's own verbs -------------------------------------------------

const sendMessage = capability({
  name: 'send_message',
  summary: 'Send text, files or both to whoever this thread talks to',
  description:
    'Send text, files or both to whoever this thread talks to: the user, or your operator when the thread is headless.',
  input: z.strictObject({
    text: z.string().describe('Standard Markdown.').optional(),
    files: z.array(FileId).optional(),
  }),
  inputRules: [{ atLeastOne: ['text', 'files'] }],
  output: z.null(),
  async run(input, ctx) {
    const { caller } = ctx;
    const thread = await callingThread(caller);
    const text = input.text === undefined ? null : said('text', input.text);
    const files = await storedFiles(caller, input.files);

    if (text === null && !files.length) {
      throw new CapabilityError('invalid_input', 'There is nothing to send: pass text, files or both.');
    }

    // A headless thread talks to its operator: the message is addressed to
    // the parent thread. A message between threads always says something;
    // files sent alone are named.
    if (thread.headless && thread.parentId !== null) {
      await write({
        type: THREAD_MESSAGE,
        actor: 'agent',
        agentName: caller.agentName,
        workspaceId: caller.workspaceId,
        threadId: thread.id,
        targetThreadId: thread.parentId,
        payload: withOrigin(
          {
            text: text ?? files.map(file => `[file] ${file.originalFilename ?? file.id}`).join('\n'),
            ...(files.length ? { fileIds: files.map(file => file.id), files: files.map(messageFile) } : {}),
          },
          ctx,
        ),
      });

      return null;
    }

    const content: ContentBlock[] = [...(text === null ? [] : [{ type: 'text' as const, text }]), ...files.map(fileContentBlock)];

    await write({
      type: 'agent.message',
      actor: 'agent',
      agentName: caller.agentName,
      workspaceId: caller.workspaceId,
      threadId: thread.id,
      payload: withOrigin({ content: content as unknown as Json[] }, ctx),
    });

    return null;
  },
});

const endThread = capability({
  name: 'end_thread',
  summary: 'End this thread and leave its report',
  description:
    'End this thread and leave its report. The summary reaches your operator and, when the thread talks to the user, the user. The thread closes when the current turn ends: start nothing new after the call.',
  input: z.strictObject({
    title: z.string().min(1).describe('2–5 words naming the work done, not the agent.'),
    description: z.string().min(1).describe('About 300 characters: what was worked on and how it ended.'),
    summary: z.string().min(1).describe('The report: outcome, decisions, produced files, what remains.'),
    files: z.array(FileId).describe('Files that belong with the report.').optional(),
    project: z.string().describe('Slug of the project the work concerned. Default: the one set at start.').optional(),
  }),
  output: z.null(),
  async run(input, { caller }) {
    const thread = await callingThread(caller);

    if (thread.parentId === null) {
      throw new CapabilityError('conflict', 'This is the main thread of the workspace: it never ends.');
    }

    const title = said('title', input.title);
    const description = said('description', input.description);
    const text = said('summary', input.summary);
    const files = await storedFiles(caller, input.files);
    const project = await namedProject(caller, input.project);

    // The thread goes on to the end of its turn; whoever runs the turn
    // completes the thread with the report (src/core/thread-end.ts).
    leaveReport(thread.id, {
      title,
      description,
      summary: { text, ...(files.length ? { fileIds: files.map(file => file.id) } : {}) },
      ...(project ? { project } : {}),
    });

    return null;
  },
});

// --- The verbs of a child thread -------------------------------------------

// The agents a thread may start.
function startable(thread: Thread, caller: Caller): CatalogAgent[] {
  if (thread.parentId === null) {
    return getAgents();
  }

  const spawner = getAgent(caller.agentName);

  return spawner && !isRemoteAgent(spawner) ? getAgents().filter(agent => mayAgentSpawn(spawner, agent.name)) : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The launch parameters of a remote agent against the schema its
// declaration gives. A parameter the schema does not name is a mistake of
// the call unless the schema lets any through: the external system would
// drop it in silence.
function fitOptions(agent: RemoteAgentDeclaration, options: Json): void {
  const schema = agent.options ?? { type: 'object', properties: {} };
  const known = isPlainObject(schema.properties) ? Object.keys(schema.properties) : [];
  const unknown = schema.additionalProperties === undefined || schema.additionalProperties === false ? Object.keys(options).filter(key => !known.includes(key)) : [];

  if (unknown.length) {
    throw new CapabilityError(
      'invalid_input',
      `options: "${agent.name}" has no launch parameter ${unknown.map(key => `"${key}"`).join(', ')}. ${
        known.length ? `Its parameters: ${JSON.stringify(schema.properties)}` : 'It takes none: leave options out.'
      }`,
    );
  }

  let fit: z.ZodType;

  try {
    fit = z.fromJSONSchema(schema as never);
  } catch {
    // A schema that cannot be read checks nothing: the external system has
    // the last word on its own parameters.
    return;
  }

  const parsed = fit.safeParse(options);

  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || 'options'}: ${issue.message}`).join('; ');

    throw new CapabilityError(
      'invalid_input',
      `options do not fit the launch parameters of "${agent.name}" — ${issues}. Its parameters: ${JSON.stringify(schema.properties ?? {})}`,
    );
  }
}

const spawnAgent = capability({
  name: 'spawn_agent',
  summary: 'Start a child thread run by an agent and become its operator',
  description:
    "Start a child thread run by an agent and become its operator. The agent works asynchronously. A headless child talks only to you: its replies arrive as messages labeled with its threadId; otherwise it talks to the user. Its summary arrives when the thread ends. A remote agent's thread mirrors a session in an external system: it never ends on its own, pauses when idle, and a message wakes it.",
  input: z.strictObject({
    agent: z.string().describe('Name of the agent.'),
    title: z.string().describe("Names the task, not the agent; in the user's language."),
    prompt: z.string().describe('The task, with everything the agent starts from.').optional(),
    adopt: z
      .string()
      .describe('Remote agents: id or link of an existing session to attach instead of starting one.')
      .optional(),
    headless: z
      .boolean()
      .describe("A headless child talks to its operator. Tasks and child threads default to headless when available. The secretary uses the agent's default.")
      .optional(),
    files: z.array(FileId).describe('Attached to the first message. Not with adopt.').optional(),
    project: z.string().describe('Slug of the project the work concerns.').optional(),
    options: JsonObject.describe("Remote agents: launch parameters; form set by the agent's options schema.").optional(),
  }),
  inputRules: [{ exactlyOne: ['prompt', 'adopt'] }],
  output: z.strictObject({
    threadId: z.string(),
    headless: z.boolean().describe('The mode the child actually runs in.'),
  }),
  async run(input, ctx) {
    const { caller } = ctx;
    const parent = await callingThread(caller);
    const allowed = startable(parent, caller);
    const agent = allowed.find(candidate => candidate.name === input.agent);

    if (!agent) {
      const names = allowed.map(candidate => candidate.name);

      throw new CapabilityError(
        'invalid_input',
        `There is no agent "${input.agent}" you can start. ${names.length ? `You can start: ${names.join(', ')}.` : 'This thread starts no agents.'}`,
      );
    }

    const remote = isRemoteAgent(agent);
    const title = said('title', input.title);
    const prompt = input.prompt === undefined ? undefined : said('prompt', input.prompt);
    const adopt = input.adopt === undefined ? undefined : said('adopt', input.adopt);

    if (!remote && (adopt !== undefined || input.options !== undefined)) {
      throw new CapabilityError(
        'invalid_input',
        `"${agent.name}" is not a remote agent: it takes no ${adopt !== undefined ? 'adopt' : 'options'}. Pass the task in prompt.`,
      );
    }

    if (adopt !== undefined && input.files?.length) {
      throw new CapabilityError(
        'invalid_input',
        'An adopted session takes no files at its start: send them with `send_to_thread` once the thread is open.',
      );
    }

    // The launch parameters are what a session is opened with: one that
    // exists already runs on its own, and the thread would only be labeled
    // with parameters the session does not have.
    if (adopt !== undefined && input.options !== undefined) {
      throw new CapabilityError(
        'invalid_input',
        'An adopted session takes no options: it keeps the parameters it was started with. Leave options out.',
      );
    }

    // An agent of the repository runs in the one mode it declares; a remote
    // agent in either, by default the one its spawner implies.
    const own = remote ? parent.parentId !== null || ctx.program?.task != null : agent.headless === true;
    const headless = input.headless ?? own;

    if (!remote && headless !== own) {
      throw new CapabilityError(
        'invalid_input',
        `"${agent.name}" runs only ${own ? 'headless: it talks to its operator' : 'in a thread that talks to the user'}. Pass headless: ${own} or leave the field out.`,
      );
    }

    if (remote && input.options !== undefined) {
      fitOptions(agent, input.options);
    }

    const files = await storedFiles(caller, input.files);
    const project = await namedProject(caller, input.project);
    const program = programOf(ctx);
    let child: Thread;

    try {
      child = await startThread({
        workspaceId: caller.workspaceId,
        parentThreadId: parent.id,
        agent: agent.name,
        title,
        input: prompt ?? adopt,
        icon: agent.icon,
        headless,
        ...(remote ? { remote: true, options: input.options ?? {}, adopt: adopt !== undefined } : {}),
        ...(files.length ? { files } : {}),
        ...(project ? { project } : {}),
        ...(program ? { program } : {}),
        actor: 'agent',
        agentName: caller.agentName,
      });
    } catch (error) {
      throw logRefusal(error);
    }

    return { threadId: child.id, headless };
  },
});

const sendToThread = capability({
  name: 'send_to_thread',
  summary: 'Send a message into an active child thread',
  description:
    "Send a message into an active child thread. For a remote child it reaches the external session as the user's word and wakes a paused thread.",
  input: z.strictObject({
    threadId: z.string(),
    text: z.string().min(1),
    files: z.array(FileId).optional(),
  }),
  output: z.null(),
  async run(input, ctx) {
    const { caller } = ctx;
    const child = await activeChild(caller, input.threadId);
    const text = said('text', input.text);
    const files = await storedFiles(caller, input.files);
    const result = await write({
      type: THREAD_MESSAGE,
      actor: 'agent',
      agentName: caller.agentName,
      workspaceId: caller.workspaceId,
      threadId: caller.threadId,
      targetThreadId: child.id,
      payload: withOrigin(
        { text, ...(files.length ? { fileIds: files.map(file => file.id), files: files.map(messageFile) } : {}) },
        ctx,
      ),
    });

    // The child ended while the message was on its way: the log keeps the
    // message in the main thread, the child never reads it.
    if (result.written && result.event.targetThreadId !== child.id) {
      throw new CapabilityError('conflict', `The thread "${child.id}" has already ended: the message did not reach it.`);
    }

    return null;
  },
});

// A command to a child the log did not take: the child ended in between.
function taken(result: AppendResult, child: Thread): null {
  if (!result.written) {
    throw new CapabilityError('conflict', `The thread "${child.id}" has already ended.`);
  }

  return null;
}

const finishThread = capability({
  name: 'finish_thread',
  summary: 'Ask an active child thread to wrap up and report',
  description:
    'Ask an active child thread to wrap up and report. The child finishes its current turn, writes its report and ends; the summary arrives later, as its completion. A remote session writes a closing summary and stays alive.',
  input: z.strictObject({ threadId: z.string() }),
  output: z.null(),
  async run(input, ctx) {
    const { caller } = ctx;
    const child = await activeChild(caller, input.threadId);

    return taken(
      await write({
        type: THREAD_FINISH,
        actor: 'agent',
        agentName: caller.agentName,
        workspaceId: caller.workspaceId,
        threadId: caller.threadId,
        targetThreadId: child.id,
        payload: withOrigin({ reason: 'finished_by_parent' }, ctx),
      }),
      child,
    );
  },
});

const cancelThread = capability({
  name: 'cancel_thread',
  summary: 'Stop an active child thread at once, without a report',
  description:
    "Stop an active child thread at once; no summary is written. A local agent's work stops; a remote session is left intact.",
  input: z.strictObject({ threadId: z.string(), reason: z.string().optional() }),
  output: z.null(),
  async run(input, ctx) {
    const { caller } = ctx;
    const child = await activeChild(caller, input.threadId);

    return taken(
      await write({
        type: THREAD_CANCEL,
        actor: 'agent',
        agentName: caller.agentName,
        workspaceId: caller.workspaceId,
        threadId: caller.threadId,
        targetThreadId: child.id,
        payload: withOrigin({ reason: input.reason?.trim() || 'cancelled' }, ctx),
      }),
      child,
    );
  },
});

// What a refusal of the remote engine means for the one who asked.
function fileRefusal(code: RemoteFileRefusal, threadId: string, path: string, said: string): CapabilityError {
  switch (code) {
    case 'not_remote':
      return new CapabilityError('conflict', `The thread "${threadId}" has no open session: there is nothing to fetch a file from.`);
    case 'ended':
      return new CapabilityError('conflict', `The thread "${threadId}" has already ended.`);
    case 'not_owner':
      return new CapabilityError('invalid_input', `The thread "${threadId}" is neither a child of this thread nor this thread itself.`);
    case 'cannot_fetch':
      return new CapabilityError('invalid_input', `The external system of the thread "${threadId}" cannot hand out files.`);
    // The external system answers "nothing" alike for a path that is not
    // there and for a session that sleeps: what is known is whether the
    // thread is paused here, and the words say no more than that.
    case 'asleep':
      return new CapabilityError(
        'conflict',
        `The session of the thread "${threadId}" gave no file at "${path}", and the thread is paused: a session that is asleep hands out nothing. Wake it with a message and ask again.`,
      );
    case 'no_file':
      return new CapabilityError(
        'not_found',
        `The session of the thread "${threadId}" gave no file at "${path}": no such path there — or the session fell asleep on its side, and a message to the thread wakes it.`,
      );
    case 'refused':
      return new CapabilityError('external_error', `The external system refused to hand out "${path}": ${said}`);
    case 'not_loaded':
      return new CapabilityError('unavailable', `The external system of the thread "${threadId}" is not loaded in this installation.`);
    case 'no_answer':
      return new CapabilityError('unavailable', `The external system did not answer in time: ${said}`);
  }
}

const fetchThreadFile = capability({
  name: 'fetch_thread_file',
  summary: "Bring a file out of a remote thread's session into storage",
  description:
    "Bring a file out of a remote agent's session into Balabash storage by its absolute path there. It works for an active remote thread you operate, or your own, while its session is awake. The file also appears in that thread.",
  input: z.strictObject({
    threadId: z.string().describe('The remote thread whose session holds the file.'),
    path: z.string().describe('Absolute path inside the session.'),
  }),
  output: FileRef,
  async run(input, { caller }) {
    const thread = await workspaceThread(caller, input.threadId);
    const path = input.path.trim();

    if (!thread.remote) {
      throw new CapabilityError(
        'invalid_input',
        `The thread "${thread.id}" is not remote: it has no session in an external system to fetch a file from.`,
      );
    }

    if (thread.parentId !== caller.threadId && thread.id !== caller.threadId) {
      throw fileRefusal('not_owner', thread.id, path, '');
    }

    if (thread.status !== 'active') {
      throw endedThread(thread);
    }

    if (!path.startsWith('/')) {
      throw new CapabilityError('invalid_input', 'path is not absolute: pass the path of the file inside the session from its root, starting with "/".');
    }

    try {
      return fileRefValue(await fetchRemoteFile(thread.id, path, { workspaceId: caller.workspaceId, threadId: caller.threadId }));
    } catch (error) {
      throw error instanceof RemoteFileError ? fileRefusal(error.code, thread.id, path, error.message) : error;
    }
  },
});

export const threadVerbs = { sendMessage, endThread, spawnAgent, sendToThread, finishThread, cancelThread, fetchThreadFile };
