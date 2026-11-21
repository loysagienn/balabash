// The verbs of a thread over the stand, through the one path of a call: what
// a verb writes is read where the app keeps it — the events of the log, the
// rows of the threads, the report a thread left for the end of its turn.
// The agents are the repository's own declarations and one remote agent of
// the test over a driver in memory; no run is started — the stand has no
// router — so a child is a thread and its thread.started, and a remote
// thread is opened the way the router's hook opens it.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { CapabilityError, computeGrant, invokeCapability } from '../catalog/index.ts';
import type { ErrorKind, Grant } from '../catalog/index.ts';
import type { CatalogAccess, JsonObject, RemoteAgentDeclaration, RemoteDriver, RemoteDriverContext } from '../core/contract.ts';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let tree: typeof import('./index.ts');
let services: typeof import('./services.ts');
let threads: typeof import('../core/threads.ts');
let append: typeof import('../core/append.ts');
let envelope: typeof import('../core/envelope.ts');
let reports: typeof import('../core/thread-end.ts');
let files: typeof import('../files/index.ts');
let engine: typeof import('../remote/engine.ts');
let main: Grant;

type Value = Record<string, any>;

// The external system of the test: sessions by reference, each with the
// files it holds.
const sessions = new Map<string, Record<string, string>>();
let opened = 0;

const driver: RemoteDriver = {
  open: async () => {
    const ref = `sess-${(opened += 1)}`;

    sessions.set(ref, {});

    return { ref, link: `https://ext/${ref}` };
  },
  describe: async (_ctx, ref) => {
    sessions.set(ref, sessions.get(ref) ?? {});

    return { exists: true, link: `https://ext/${ref}` };
  },
  read: async (_ctx, { cursor }) => ({ cursor: cursor ?? 'c0', phase: 'idle', items: [] }),
  say: async () => {},
  answer: async () => {},
  stop: async () => {},
  fetchFile: async (_ctx, { ref, path }) => {
    if (path === '/refused') {
      throw new Error('403 from the sandbox');
    }

    const body = sessions.get(ref)?.[path];

    return body === undefined ? null : { body, filename: path.split('/').pop()!, contentType: 'text/plain' };
  },
};

const remoteAgent: RemoteAgentDeclaration = {
  kind: 'remote',
  recipients: ['coordinator', 'general'],
  modes: ['user', 'headless'],
  defaultMode: 'user',
  name: 'fake_agent',
  description: 'A session in the external system of the test.',
  options: {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'The model of the session.' },
      effort: { type: 'string', enum: ['low', 'high'] },
    },
  },
  driver,
};

async function grantOf(threadId: string, agentName: string, workspaceId = stand.workspaceId): Promise<Grant> {
  return computeGrant(
    tree.catalog(),
    { allows: () => true, actions: ['describe', 'call', 'run_program'] },
    { caller: { workspaceId, threadId, agentName }, connections: services.connectionsPort() },
  );
}

function invoke(name: string, input: JsonObject, as: Grant = main): Promise<Value> {
  return invokeCapability(as, name, input, { connections: services.connectionsPort() }) as Promise<Value>;
}

async function refuses(call: Promise<unknown>, kind: ErrorKind, message: RegExp): Promise<void> {
  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof CapabilityError, `a CapabilityError, got ${String(error)}`);
    assert.equal(error.kind, kind, error.message);
    assert.match(error.message, message);

    return true;
  });
}

async function until<T>(read: () => Promise<T | null | undefined | false>, what: string, withinMs = 15_000): Promise<T> {
  for (const started = Date.now(); Date.now() - started < withinMs; ) {
    const value = await read();

    if (value) {
      return value;
    }

    await new Promise(resolve => setTimeout(resolve, 25));
  }

  return assert.fail(`timed out waiting for ${what}`);
}

// The events of a type a thread wrote, oldest first.
async function written(threadId: string, type: string) {
  const events = await prisma.event.findMany({ where: { threadId, type }, orderBy: { seq: 'asc' } });

  return events.map(event => ({ ...event, payload: event.payload as Value }));
}

async function lastWritten(threadId: string, type: string) {
  const event = (await written(threadId, type)).at(-1);

  assert.ok(event, `${type} of ${threadId}`);

  return event;
}

async function started(threadId: string) {
  return lastWritten(threadId, 'thread.started');
}

async function storeText(name: string, content: string, contentType = 'text/plain'): Promise<string> {
  const file = await files.ingestFile({ body: content, workspaceId: stand.workspaceId, originalFilename: name, contentType });

  return file.id;
}

// A child of the main thread, started through the capability; the grant of
// a call made on its behalf.
async function child(agent: string, extra: JsonObject = {}): Promise<{ threadId: string; grant: Grant }> {
  const { threadId } = await invoke('spawn_agent', { agent, title: `A task for ${agent}`, prompt: 'Do the task.', ...extra });

  return { threadId, grant: await grantOf(threadId, agent) };
}

// A remote child with its session open: what the router's hook does on its
// thread.started.
async function remoteChild(extra: JsonObject = {}, as: Grant = main): Promise<{ threadId: string; ref: string }> {
  const { threadId } = await invoke('spawn_agent', { agent: 'fake_agent', title: 'Remote work', prompt: 'Do it there.', ...extra }, as);
  const thread = (await threads.getThread(threadId))!;
  const event = await prisma.event.findUniqueOrThrow({ where: { seq: thread.createdSeq } });

  await engine.openRemoteThread(thread, envelope.toEvent(event));
  await engine.settled();

  const row = await prisma.remoteThread.findUniqueOrThrow({ where: { threadId } });

  return { threadId, ref: row.ref };
}

async function end(threadId: string): Promise<void> {
  const result = await append.appendEvent({
    type: 'thread.cancelled',
    actor: 'system',
    workspaceId: stand.workspaceId,
    threadId,
    payload: { reason: 'test' },
  });

  assert.ok(result.written);
}

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  tree = await import('./index.ts');
  services = await import('./services.ts');
  threads = await import('../core/threads.ts');
  append = await import('../core/append.ts');
  envelope = await import('../core/envelope.ts');
  reports = await import('../core/thread-end.ts');
  files = await import('../files/index.ts');
  engine = await import('../remote/engine.ts');

  const { loadAgents } = await import('../capabilities/agent-catalog.ts');
  const { workspaceFilesDir } = await import('../workspace/layout.ts');
  const context: RemoteDriverContext = {
    secrets: { get: async () => 'token' },
    files: { ingest: input => files.ingestFile(input), get: fileId => files.getFile(fileId), open: fileId => files.openFileContent(fileId) },
  };

  loadAgents([
    remoteAgent,
    { ...remoteAgent, name: 'unassigned', recipients: [] },
    { ...remoteAgent, name: 'private_agent', recipients: ['auth'], modes: ['user'], defaultMode: 'user' },
  ]);
  engine.configureRemoteEngine({
    resolveKind: kind => (kind === 'fake_agent' ? { driver, context, notification: undefined } : null),
    verbTimeoutMs: 2_000,
  });
  // What the app does at its start: the schedule gets the catalog its
  // programs run against.
  await tree.startTree();
  await fs.mkdir(workspaceFilesDir(stand.workspaceId), { recursive: true });
  main = await grantOf(stand.mainThreadId, 'coordinator');
});

after(async () => {
  tree.stopRunningWork();
  await engine.settled();
  await stand.stop();
});

describe('agent passports', () => {
  test('every profile and repository passport names tree nodes with their parents and capabilities of the root', async () => {
    const { accessProfiles, coordinator } = await import('../../agents/access.ts');
    const { getAgents, isRemoteAgent } = await import('../capabilities/agent-catalog.ts');
    const catalog = tree.catalog();

    function check(owner: string, access: CatalogAccess) {
      const profile = access.profile;
      if (profile !== undefined) {
        assert.ok(Object.hasOwn(accessProfiles, profile), `${owner}: unknown profile "${profile}"`);
      }
      const nodes = new Set([...(profile ? accessProfiles[profile].nodes ?? [] : []), ...(access.nodes ?? [])]);
      for (const name of nodes) {
        const node = catalog.vertices.get(name);
        assert.ok(node?.kind === 'node' && node.parent, `${owner}: "${name}" must name a node below the root`);
        assert.ok(node.parent === catalog.root || nodes.has(node.parent.fullName), `${owner}: "${name}" needs parent "${node.parent.fullName}"`);
      }
      for (const name of [...(access.addRoot ?? []), ...(access.removeRoot ?? [])]) {
        const vertex = catalog.vertices.get(name);
        assert.ok(vertex?.kind === 'capability' && vertex.parent === catalog.root, `${owner}: "${name}" must name a root capability`);
      }
    }

    for (const [name, profile] of Object.entries(accessProfiles)) {
      check(`profile ${name}`, profile);
    }
    check(coordinator.name, coordinator.access);
    for (const agent of getAgents()) {
      if (!isRemoteAgent(agent)) {
        check(agent.name, agent.access);
      }
    }
  });

  test('the catalog grants named nodes, file and child verbs, and explicit root overrides', async () => {
    const { coordinator } = await import('../../agents/access.ts');
    const { agentGrantPolicy, passport } = await import('../capabilities/agent-catalog.ts');
    const vertices = async (name: string) => {
      const agent = passport(name)!;
      const grant = await computeGrant(tree.catalog(), agentGrantPolicy(agent, ['describe', 'call']), {
        caller: { workspaceId: stand.workspaceId, threadId: stand.mainThreadId, agentName: name },
        connections: services.connectionsPort(),
      });
      return grant.vertices;
    };
    const narrowed = agentGrantPolicy({ ...coordinator, access: { removeRoot: ['send_message'] } }, ['call']);
    assert.equal(narrowed.allows(tree.catalog().vertices.get('send_message')!), false);

    const secretary = await vertices('coordinator');
    assert.ok(['export_file', 'import_file', 'view_file', 'get_event', 'fetch_thread_file', 'spawn_agent', 'workspace_apps_list'].every(name => secretary.has(name)));
    assert.ok(!secretary.has('get_file_url') && !secretary.has('end_thread'));

    const engineer = await vertices('engineer');
    assert.ok(['get_event', 'fetch_thread_file', 'system_request_restart', 'get_file_url', 'workspace_query'].every(name => engineer.has(name)));
    assert.ok(!engineer.has('view_file') && !engineer.has('workspace_apps_list'));

    const auth = await vertices('auth');
    assert.ok(auth.has('spawn_agent') && auth.has('connections_list') && auth.has('get_event'));
    assert.ok(!auth.has('fetch_thread_file') && !auth.has('import_file'));

    const leaf = await vertices('image_generator');
    assert.deepEqual([...leaf].sort(), ['', 'end_thread', 'export_file', 'get_file_url', 'import_file', 'send_message']);
    assert.deepEqual([...(await vertices('fake_agent'))].sort(), ['', 'end_thread', 'get_file_url', 'send_message']);
  });

  test('a loaded remote kind is offered and callable only by its recipients', async () => {
    const { getAgent, startable } = await import('../capabilities/agent-catalog.ts');
    const names = (agent: string) => startable(agent).map(child => child.name);
    assert.ok(getAgent('unassigned'));
    assert.ok(names('engineer').includes('fake_agent')); // recipient by profile
    assert.ok(!names('gardener').includes('fake_agent')); // projects alone grants nothing
    assert.deepEqual(names('auth'), ['private_agent']);
    assert.ok(names('coordinator').includes('fake_agent'));
    for (const name of ['unassigned', 'private_agent']) {
      assert.ok(!names('coordinator').includes(name));
      await refuses(invoke('spawn_agent', { agent: name, title: 'Work', prompt: 'Work' }), 'invalid_input', /you can start/);
    }

    const { grant } = await child('auth');
    const input = { agent: 'private_agent', title: 'Test', prompt: 'Work' };
    assert.equal((await invoke('spawn_agent', input, grant)).headless, false);
    await refuses(invoke('spawn_agent', { ...input, headless: true }, grant), 'invalid_input', /headless: false/);
  });
});

describe('send_message', () => {
  test('a thread that talks to the user says it in one agent.message: the text, then a block per file', async () => {
    const note = await storeText('note.txt', 'a note');
    const picture = await storeText('chart.png', 'not really a picture', 'image/png');

    assert.equal(await invoke('send_message', { text: 'Here **it** is.', files: [note, picture, note] }), null);

    const message = await lastWritten(stand.mainThreadId, 'agent.message');

    assert.equal(message.actor, 'agent');
    assert.equal(message.agentName, 'coordinator');
    assert.deepEqual(
      message.payload.content.map((block: Value) => [block.type, block.text ?? block.fileId]),
      [['text', 'Here **it** is.'], ['file', note], ['image', picture]],
    );
    assert.equal(message.payload.content[1].name, 'note.txt');

    // Files alone are a message too.
    await invoke('send_message', { files: [note] });
    assert.deepEqual(
      (await lastWritten(stand.mainThreadId, 'agent.message')).payload.content.map((block: Value) => block.type),
      ['file'],
    );
  });

  test('a headless thread says it to its operator: a thread.message to the parent, files alone are named', async () => {
    const { threadId, grant } = await child('browser');
    const shot = await storeText('shot.txt', 'a screenshot');

    await invoke('send_message', { text: 'Found it.', files: [shot] }, grant);

    const message = await lastWritten(threadId, 'thread.message');

    assert.equal(message.targetThreadId, stand.mainThreadId);
    assert.equal(message.agentName, 'browser');
    assert.equal(message.payload.text, 'Found it.');
    assert.deepEqual(message.payload.fileIds, [shot]);
    assert.deepEqual(message.payload.files, [{ fileId: shot, contentType: 'text/plain', originalFilename: 'shot.txt', sizeBytes: 12 }]);

    await invoke('send_message', { files: [shot] }, grant);
    assert.equal((await lastWritten(threadId, 'thread.message')).payload.text, '[file] shot.txt');
    assert.deepEqual(await written(threadId, 'agent.message'), []);
  });

  test('refuses a file the workspace does not have and a message that says nothing', async () => {
    const before = (await written(stand.mainThreadId, 'agent.message')).length;

    await refuses(invoke('send_message', { text: 'x', files: [randomUUID()] }), 'not_found', /no stored file/);
    await refuses(invoke('send_message', { text: '   ' }), 'invalid_input', /text is blank/);
    await refuses(invoke('send_message', { files: [] }), 'invalid_input', /nothing to send/);
    await refuses(invoke('send_message', {}), 'invalid_input', /text|files/);
    assert.equal((await written(stand.mainThreadId, 'agent.message')).length, before);
  });
});

describe('spawn_agent', () => {
  test('the main thread starts an agent in the mode the agent declares, with the task, the files and the project', async () => {
    const brief = await storeText('brief.md', '# Brief');
    const { project } = await invoke('projects_create', { title: 'Verbs', slug: 'verbs', description: 'The verbs of a thread.' });
    const answer = await invoke('spawn_agent', {
      agent: 'engineer',
      title: '  Build the thing ',
      prompt: ' Build it. ',
      files: [brief],
      project: 'verbs',
    });

    assert.deepEqual(Object.keys(answer).sort(), ['headless', 'threadId']);
    assert.equal(answer.headless, false);

    const thread = (await threads.getThread(answer.threadId))!;

    assert.deepEqual(
      [thread.parentId, thread.agent, thread.title, thread.status, thread.headless, thread.remote, thread.projectId],
      [stand.mainThreadId, 'engineer', 'Build the thing', 'active', false, false, project.id],
    );

    const event = await started(answer.threadId);

    assert.deepEqual([event.actor, event.agentName, event.targetThreadId], ['agent', 'coordinator', stand.mainThreadId]);
    assert.equal(event.payload.input, 'Build it.');
    assert.deepEqual(event.payload.fileIds, [brief]);
    assert.equal(event.payload.projectSlug, 'verbs');

    // The start of a thread of a project is work on the project.
    assert.ok((await invoke('projects_get', { project: 'verbs' })).updatedAt > project.updatedAt);

    // A headless agent runs headless, asked for or not; no other mode.
    assert.equal((await invoke('spawn_agent', { agent: 'browser', title: 'Look', prompt: 'Look.' })).headless, true);
    assert.equal((await invoke('spawn_agent', { agent: 'browser', title: 'Look', prompt: 'Look.', headless: true })).headless, true);
    await refuses(
      invoke('spawn_agent', { agent: 'browser', title: 'Look', prompt: 'Look.', headless: false }),
      'invalid_input',
      /"browser" runs only headless.*headless: true/,
    );
    await refuses(
      invoke('spawn_agent', { agent: 'engineer', title: 'Build', prompt: 'Build.', headless: true }),
      'invalid_input',
      /"engineer" runs only in a thread that talks to the user/,
    );
  });

  test('a thread starts only the agents the declaration of its agent names', async () => {
    const { threadId, grant } = await child('engineer');
    const answer = await invoke('spawn_agent', { agent: 'browser', title: 'Open the page', prompt: 'Open it.' }, grant);
    const event = await started(answer.threadId);

    assert.deepEqual([event.agentName, event.targetThreadId], ['engineer', threadId]);

    await refuses(
      invoke('spawn_agent', { agent: 'gardener', title: 'Tidy', prompt: 'Tidy.' }, grant),
      'invalid_input',
      /no agent "gardener" you can start\. You can start: .*browser/,
    );
    await refuses(invoke('spawn_agent', { agent: 'nobody', title: 'T', prompt: 'P' }), 'invalid_input', /no agent "nobody" you can start\. You can start: .*engineer/);

    // An agent that declares no sub-agents starts none.
    const leaf = await child('browser');

    await refuses(invoke('spawn_agent', { agent: 'browser', title: 'T', prompt: 'P' }, leaf.grant), 'invalid_input', /This thread starts no agents/);
  });

  test('a remote agent takes launch parameters by its schema and an existing session to adopt, in either mode', async () => {
    // A child of the main thread talks to the user unless told otherwise.
    const own = await invoke('spawn_agent', { agent: 'fake_agent', title: 'Remote', prompt: 'Work.', options: { model: 'big', effort: 'high' } });

    assert.equal(own.headless, false);

    const event = await started(own.threadId);

    assert.deepEqual(
      [event.payload.remote, event.payload.headless, event.payload.adopt, event.payload.options],
      [true, false, false, { model: 'big', effort: 'high' }],
    );
    assert.equal((await invoke('spawn_agent', { agent: 'fake_agent', title: 'Remote', prompt: 'Work.', headless: true })).headless, true);

    // A child of another thread talks to its parent.
    const engineer = await child('engineer');

    assert.equal((await invoke('spawn_agent', { agent: 'fake_agent', title: 'Remote', prompt: 'Work.' }, engineer.grant)).headless, true);

    const adopted = await invoke('spawn_agent', { agent: 'fake_agent', title: 'Adopted', adopt: ' sess-existing ' });
    const adoption = await started(adopted.threadId);

    assert.deepEqual([adoption.payload.adopt, adoption.payload.input, adoption.payload.options], [true, 'sess-existing', {}]);

    await refuses(
      invoke('spawn_agent', { agent: 'fake_agent', title: 'R', prompt: 'W', options: { modle: 'big' } }),
      'invalid_input',
      /no launch parameter "modle".*"model"/,
    );
    await refuses(
      invoke('spawn_agent', { agent: 'fake_agent', title: 'R', prompt: 'W', options: { effort: 'extreme' } }),
      'invalid_input',
      /options do not fit the launch parameters of "fake_agent" — effort/,
    );
    await refuses(
      invoke('spawn_agent', { agent: 'fake_agent', title: 'R', adopt: 'sess-1', files: [await storeText('a.txt', 'a')] }),
      'invalid_input',
      /adopted session takes no files/,
    );
    await refuses(
      invoke('spawn_agent', { agent: 'fake_agent', title: 'R', adopt: 'sess-1', options: { model: 'big' } }),
      'invalid_input',
      /adopted session takes no options/,
    );
    await refuses(invoke('spawn_agent', { agent: 'fake_agent', title: 'R', prompt: 'W', adopt: 'sess-1' }), 'invalid_input', /prompt|adopt/);
    await refuses(invoke('spawn_agent', { agent: 'fake_agent', title: 'R' }), 'invalid_input', /prompt|adopt/);
    await refuses(invoke('spawn_agent', { agent: 'engineer', title: 'E', adopt: 'sess-1' }), 'invalid_input', /not a remote agent: it takes no adopt/);
    await refuses(
      invoke('spawn_agent', { agent: 'engineer', title: 'E', prompt: 'W', options: {} }),
      'invalid_input',
      /not a remote agent: it takes no options/,
    );
  });

  test('refuses a project, a file and a task that are not there, and starts nothing', async () => {
    const before = await prisma.thread.count({ where: { workspaceId: stand.workspaceId } });

    await refuses(invoke('spawn_agent', { agent: 'engineer', title: 'T', prompt: 'P', project: 'no-such' }), 'not_found', /no project with the slug "no-such"/);
    await refuses(invoke('spawn_agent', { agent: 'engineer', title: 'T', prompt: 'P', files: [randomUUID()] }), 'not_found', /no stored file/);
    await refuses(invoke('spawn_agent', { agent: 'engineer', title: 'T', prompt: '  ' }), 'invalid_input', /prompt is blank/);
    await refuses(invoke('spawn_agent', { agent: 'engineer', title: ' ', prompt: 'P' }), 'invalid_input', /title is blank/);
    assert.equal(await prisma.thread.count({ where: { workspaceId: stand.workspaceId } }), before);
  });
});

describe('the verbs of a child thread', () => {
  test('a message, a request to finish and a cancel are events from the operator to its child', async () => {
    const { threadId } = await child('engineer');
    const spec = await storeText('spec.md', '# Spec');

    assert.equal(await invoke('send_to_thread', { threadId, text: ' One more thing. ', files: [spec] }), null);

    const message = (await written(stand.mainThreadId, 'thread.message')).filter(event => event.targetThreadId === threadId).at(-1)!;

    assert.equal(message.payload.text, 'One more thing.');
    assert.deepEqual(message.payload.fileIds, [spec]);
    assert.equal(message.payload.files[0].originalFilename, 'spec.md');
    assert.equal(message.agentName, 'coordinator');

    assert.equal(await invoke('finish_thread', { threadId }), null);

    const finish = (await written(stand.mainThreadId, 'thread.finish')).filter(event => event.targetThreadId === threadId);

    assert.equal(finish.length, 1);
    assert.deepEqual(finish[0]!.payload, { reason: 'finished_by_parent' });

    assert.equal(await invoke('cancel_thread', { threadId, reason: 'No longer needed' }), null);

    const cancel = (await written(stand.mainThreadId, 'thread.cancel')).filter(event => event.targetThreadId === threadId);

    assert.deepEqual(cancel.map(event => event.payload), [{ reason: 'No longer needed' }]);

    const other = await child('engineer');

    await invoke('cancel_thread', { threadId: other.threadId });
    assert.deepEqual((await lastWritten(stand.mainThreadId, 'thread.cancel')).payload, { reason: 'cancelled' });
  });

  test('refuse a thread that is not there, not a child of the caller, or already over', async () => {
    const parent = await child('engineer');
    const grandchild = await invoke('spawn_agent', { agent: 'browser', title: 'Deeper', prompt: 'Look.' }, parent.grant);
    const sibling = await child('engineer');
    const { id: workspaceId } = await prisma.workspace.create({ data: {} });
    const foreign = await threads.ensureMainThread(workspaceId);

    for (const verb of ['send_to_thread', 'finish_thread', 'cancel_thread']) {
      const input = (threadId: string): JsonObject => ({ threadId, ...(verb === 'send_to_thread' ? { text: 'Hello' } : {}) });

      await refuses(invoke(verb, input(randomUUID())), 'not_found', /no thread/);
      await refuses(invoke(verb, input(foreign.id)), 'not_found', /no thread/);
      // Two hops down, and sideways.
      await refuses(invoke(verb, input(grandchild.threadId)), 'invalid_input', /not a child of this thread/);
      await refuses(invoke(verb, input(sibling.threadId), parent.grant), 'invalid_input', /not a child of this thread/);
      // Up: the parent is not a child either.
      await refuses(invoke(verb, input(stand.mainThreadId), parent.grant), 'invalid_input', /not a child of this thread/);
    }

    await end(sibling.threadId);

    for (const verb of ['send_to_thread', 'finish_thread', 'cancel_thread']) {
      await refuses(
        invoke(verb, { threadId: sibling.threadId, ...(verb === 'send_to_thread' ? { text: 'Hello' } : {}) }),
        'conflict',
        /already ended \(cancelled\)/,
      );
    }

    await refuses(invoke('send_to_thread', { threadId: parent.threadId, text: '  ' }), 'invalid_input', /text is blank/);
    await refuses(invoke('send_to_thread', { threadId: parent.threadId, text: 'x', files: [randomUUID()] }), 'not_found', /no stored file/);

    // The thread of the caller is over: it starts no child.
    await end(parent.threadId);
    await refuses(invoke('spawn_agent', { agent: 'browser', title: 'T', prompt: 'P' }, parent.grant), 'conflict', /already ended: it starts no child/);
  });
});

describe('end_thread', () => {
  test('leaves the report for the end of the turn: nothing is written, the thread is still at work', async () => {
    const { threadId, grant } = await child('engineer');
    const result = await storeText('result.md', '# Result');

    await invoke('projects_create', { title: 'Endings', slug: 'endings', description: 'How threads end.' });

    assert.equal(
      await invoke(
        'end_thread',
        { title: ' Thing built ', description: 'Built the thing.', summary: 'It is built; see the file.', files: [result], project: 'endings' },
        grant,
      ),
      null,
    );

    assert.equal((await threads.getThread(threadId))!.status, 'active');
    assert.deepEqual(await written(threadId, 'thread.completed'), []);

    const report = reports.reportLeft(threadId)!;

    assert.deepEqual(
      { ...report, project: report.project?.slug },
      {
        title: 'Thing built',
        description: 'Built the thing.',
        summary: { text: 'It is built; see the file.', fileIds: [result] },
        project: 'endings',
      },
    );

    // Left again in the same turn: the later one stands, without what it
    // does not name.
    await invoke('end_thread', { title: 'Thing built', description: 'Built it.', summary: 'Done.' }, grant);
    assert.deepEqual(reports.takeReport(threadId), { title: 'Thing built', description: 'Built it.', summary: { text: 'Done.' } });
    assert.equal(reports.reportLeft(threadId), null);
  });

  test('refuses the main thread, a file and a project that are not there, and blank words', async () => {
    const { threadId, grant } = await child('engineer');
    const report = { title: 'T', description: 'D', summary: 'S' };

    await refuses(invoke('end_thread', report), 'conflict', /main thread of the workspace: it never ends/);
    await refuses(invoke('end_thread', { ...report, files: [randomUUID()] }, grant), 'not_found', /no stored file/);
    await refuses(invoke('end_thread', { ...report, project: 'no-such' }, grant), 'not_found', /no project with the slug "no-such"/);
    await refuses(invoke('end_thread', { ...report, summary: '  ' }, grant), 'invalid_input', /summary is blank/);
    await refuses(invoke('end_thread', { ...report, title: '' }, grant), 'invalid_input', /title/);
    assert.equal(reports.reportLeft(threadId), null);
  });

  test('a completion that names a project moves the thread to it and counts as work on it', async () => {
    const { project: from } = await invoke('projects_create', { title: 'Started in', slug: 'started-in', description: 'Where the thread started.' });
    const { project: to } = await invoke('projects_create', { title: 'Ended in', slug: 'ended-in', description: 'What the work turned out to concern.' });
    const { threadId } = await child('engineer', { project: 'started-in' });

    assert.equal((await threads.getThread(threadId))!.projectId, from.id);

    const result = await append.appendEvent({
      type: 'thread.completed',
      actor: 'agent',
      agentName: 'engineer',
      workspaceId: stand.workspaceId,
      threadId,
      payload: { summary: { text: 'Done.' }, title: 'Work done', description: 'Did it.', projectId: to.id, projectSlug: 'ended-in' },
    });

    assert.ok(result.written);

    const thread = (await threads.getThread(threadId))!;

    assert.deepEqual([thread.status, thread.projectId, thread.title], ['completed', to.id, 'Work done']);
    assert.ok((await invoke('projects_get', { project: 'ended-in' })).updatedAt > to.updatedAt);
  });
});

describe('fetch_thread_file', () => {
  test('brings a file of the session into storage and shows it in the thread', async () => {
    const { threadId, ref } = await remoteChild();

    sessions.get(ref)!['/workspace/out/report.txt'] = 'the report';

    const file = await invoke('fetch_thread_file', { threadId, path: '/workspace/out/report.txt' });

    assert.deepEqual(
      { ...file, id: typeof file.id },
      { kind: 'file', id: 'string', name: 'report.txt', contentType: 'text/plain', sizeBytes: 10, width: null, height: null },
    );
    assert.equal(await new Response(await files.openFileContent(file.id)).text(), 'the report');

    const shown = (await lastWritten(threadId, 'agent.message')).payload.content;

    assert.deepEqual(shown.map((block: Value) => [block.type, block.text ?? block.fileId]), [['text', '/workspace/out/report.txt'], ['file', file.id]]);
  });

  test('says why a file did not come: no such path, a sleeping session, a refusal of the system, a thread that is over', async () => {
    const { threadId, ref } = await remoteChild();

    sessions.get(ref)!['/a.txt'] = 'a';

    await refuses(invoke('fetch_thread_file', { threadId, path: '/none.txt' }), 'not_found', /no file at "\/none.txt"/);
    await refuses(invoke('fetch_thread_file', { threadId, path: 'a.txt' }), 'invalid_input', /path is not absolute/);
    await refuses(invoke('fetch_thread_file', { threadId, path: '/refused' }), 'external_error', /refused to hand out "\/refused": 403 from the sandbox/);

    // A paused thread answers "nothing" for every path: its session sleeps.
    await prisma.remoteThread.update({ where: { threadId }, data: { phase: 'paused' } });
    await refuses(invoke('fetch_thread_file', { threadId, path: '/none.txt' }), 'conflict', /asleep/);
    await prisma.remoteThread.update({ where: { threadId }, data: { phase: 'idle' } });

    // Not the operator of the thread.
    const stranger = await child('engineer');

    await refuses(invoke('fetch_thread_file', { threadId, path: '/a.txt' }, stranger.grant), 'invalid_input', /neither a child of this thread nor this thread itself/);
    // Not a remote thread, no thread at all.
    await refuses(invoke('fetch_thread_file', { threadId: stranger.threadId, path: '/a.txt' }), 'invalid_input', /is not remote/);
    await refuses(invoke('fetch_thread_file', { threadId: randomUUID(), path: '/a.txt' }), 'not_found', /no thread/);

    await end(threadId);
    await refuses(invoke('fetch_thread_file', { threadId, path: '/a.txt' }), 'conflict', /already ended/);
  });
});

describe('a program', () => {
  test('of the schedule acts as the task in the main thread', async () => {
    const code = [
      "await call('send_message', { text: 'The morning digest is ready.' });",
      "const child = await call('spawn_agent', { agent: 'browser', title: 'Check the page', prompt: 'Open it.' });",
      "await call('send_to_thread', { threadId: child.threadId, text: 'Start with the top.' });",
      "await call('finish_thread', { threadId: child.threadId });",
      "await call('cancel_thread', { threadId: child.threadId, reason: 'Done.' });",
      "await call('schedule_create_task', { slug: 'digest-note', name: 'Later', kind: 'note', note: 'Read.' });",
      'let ending;',
      "try { await call('end_thread', { title: 'T', description: 'D', summary: 'S' }); } catch (error) { ending = error.kind; }",
      "const remote = await call('spawn_agent', { agent: 'fake_agent', title: 'Remote', prompt: 'Work.' });",
      "const surfaced = await call('spawn_agent', { agent: 'fake_agent', title: 'Talk to user', prompt: 'Work.', headless: false });",
      'return { child: child.threadId, ending, modes: [remote.headless, surfaced.headless] };',
    ].join('\n');

    await invoke('schedule_create_task', { slug: 'digest', name: 'Digest', kind: 'program', code });

    const head = (await prisma.event.findFirst({ orderBy: { seq: 'desc' } }))?.seq ?? 0n;
    const { runId } = await invoke('schedule_run_task', { slug: 'digest' });
    const run = await until(async () => {
      const state = await invoke('schedule_get_run', { runId });

      return state.status === 'running' ? null : state;
    }, 'the end of the run');

    assert.equal(run.status, 'ok', run.error);
    // The main thread never ends: a scheduled program has no such verb.
    assert.equal(run.value.ending, 'unknown_capability');

    const message = (await written(stand.mainThreadId, 'agent.message')).find(event => event.payload.content[0]?.text === 'The morning digest is ready.')!;
    const birth = await started(run.value.child);

    assert.equal(birth.targetThreadId, stand.mainThreadId);

    const word = (await written(stand.mainThreadId, 'thread.message')).find(event => event.targetThreadId === run.value.child)!;

    assert.equal(word.payload.text, 'Start with the top.');

    const finish = await lastWritten(stand.mainThreadId, 'thread.finish');
    const cancel = await lastWritten(stand.mainThreadId, 'thread.cancel');
    const note = await lastWritten(stand.mainThreadId, 'schedule.task.created');
    assert.equal(note.payload.createdBy, 'task digest');

    for (const event of [message, birth, word, finish, cancel, note]) {
      assert.deepEqual([event.actor, event.agentName, event.taskSlug, event.taskRunId], ['task', null, 'digest', runId]);
    }
    assert.equal(await prisma.event.count({ where: { type: { startsWith: 'tool.call.' }, seq: { gt: head } } }), 0);
    const childTranscript = await invoke('threads_get_transcript', { threadId: run.value.child });
    const [spawn] = childTranscript.transcript.split('\n').map((line: string) => JSON.parse(line));
    assert.deepEqual([spawn.actor, spawn.task, spawn.payload.agent], ['task', { slug: 'digest', runId }, 'browser']);

    assert.deepEqual(run.value.modes, [true, false]);
  });

  test('readers distinguish a recorded agent message and a scheduled task message in the same thread', async () => {
    const { buildTranscript } = await import('../harness/openai/transcript.ts');
    const { getTranscript } = await import('../core/events.ts');
    const threadId = stand.mainThreadId;
    const base = { type: 'agent.message', workspaceId: stand.workspaceId, threadId };
    const agent = { ...base, actor: 'agent', agentName: 'coordinator' };
    const content = [{ type: 'text', text: 'Ready' }];
    const task = { slug: 'digest', runId: 'from-schedule' };

    await prisma.event.createMany({ data: [
      { ...agent, payload: { content } },
      { ...base, actor: 'task', taskSlug: task.slug, taskRunId: task.runId, payload: { content } },
    ] });

    const events = await getTranscript(threadId, { last: 2 });
    const lines = buildTranscript(events).text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).filter(line => line.type === 'agent.message');
    assert.deepEqual(lines.map(line => [line.text, line.task]), [['Ready', undefined], ['Ready', task]]);

    const page = await invoke('threads_get_transcript', { threadId, limit: 2 });
    const authors = page.transcript.split('\n').map((line: string) => JSON.parse(line)).map((e: Value) => [e.actor, e.agentName, e.task]);
    assert.deepEqual(authors, [['agent', 'coordinator', undefined], ['task', undefined, task]]);
    const full = await invoke('get_event', { seq: Number(events[1]!.seq) });
    assert.deepEqual([full.actor, full.task], ['task', task]);
  });

  test('run in place by the secretary uses the same child mode as a direct call', async () => {
    const { runProgram } = await import('../catalog/index.ts');
    const code = "const child = await call('spawn_agent', { agent: 'fake_agent', title: 'Remote', prompt: 'Work.' }); return child.headless;";
    const result = await runProgram(main, { code }, { connections: services.connectionsPort() });

    assert.equal(result, false);
  });

  test('run in place by a thread writes an ordinary event of its agent', async () => {
    const { threadId, grant } = await child('browser');
    const { runProgram } = await import('../catalog/index.ts');

    await runProgram(grant, { code: "await call('send_message', { text: 'From a program.' }); return null;" }, { connections: services.connectionsPort() });

    const message = await lastWritten(threadId, 'thread.message');

    assert.equal(message.payload.text, 'From a program.');
    assert.deepEqual([message.actor, message.agentName, message.taskSlug, message.taskRunId], ['agent', 'browser', null, null]);
  });
});
