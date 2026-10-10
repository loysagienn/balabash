// The pieces of the snapshot over the stand (src/test-support/stand.ts):
// the last message of the main thread the pinned row shows before the
// thread is opened — the newest user.message or agent.message of the
// thread's feed, authored in it or addressed to it — the threads of
// the api carrying their headless policy (GET /threads/:id answers the
// thread alone; a headless thread refuses the operator's message), and the
// agent catalog the console shows: the coordinator ahead of the catalog,
// the platform's default effort, the model of each agent's newest session
// — and the open requests for installation credentials with the events
// that open and close them, as the bell of the console reads them.
// The whole GET /api/snapshot stays out: buildSnapshot reads config.domain,
// which the stand strips with the other domains (checks.md).
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { JsonObject, Thread } from '../core/contract.ts';
import type { SecretRequestRecord } from '../core/event-types.ts';
import type { OpenSecretRequestView, SecretRequestResponse, ThreadResponse, ThreadsResponse } from './contract.ts';
import { secretRequestFromRecord } from '../console/store/records.ts';

type ErrorBody = { error: { code: string; message: string } };

let stand: Stand;
let appendEvent: typeof import('../core/append.ts')['appendEvent'];
let readMainLastMessage: typeof import('./snapshot.ts')['readMainLastMessage'];
let readAgents: typeof import('./snapshot.ts')['readAgents'];
let loadAgents: typeof import('../capabilities/agent-catalog.ts')['loadAgents'];
let getAgents: typeof import('../capabilities/agent-catalog.ts')['getAgents'];
let COORDINATOR_BUNDLE: typeof import('../coordinator/functions.ts')['COORDINATOR_BUNDLE'];
let getEventsAfter: typeof import('../core/events.ts')['getEventsAfter'];
let prisma: typeof import('../db/client.ts')['prisma'];
let startedModel: typeof import('../projections/last-model.ts')['startedModel'];
let openSecretRequest: typeof import('../capabilities/secret-requests.ts')['openSecretRequest'];
let readOpenSecretRequests: typeof import('../capabilities/secret-requests.ts')['readOpenSecretRequests'];

before(async () => {
  stand = await startStand();
  ({ appendEvent } = await import('../core/append.ts'));
  ({ readMainLastMessage, readAgents } = await import('./snapshot.ts'));
  ({ loadAgents, getAgents } = await import('../capabilities/agent-catalog.ts'));
  ({ COORDINATOR_BUNDLE } = await import('../coordinator/functions.ts'));
  ({ getEventsAfter } = await import('../core/events.ts'));
  ({ prisma } = await import('../db/client.ts'));
  ({ startedModel } = await import('../projections/last-model.ts'));
  ({ openSecretRequest, readOpenSecretRequests } = await import('../capabilities/secret-requests.ts'));
});

after(() => stand.stop());

async function startChild(agent: string, policy: JsonObject = {}): Promise<string> {
  const id = randomUUID();

  await appendEvent({ type: 'thread.started', actor: 'system', userId: stand.userId, threadId: id, targetThreadId: stand.mainThreadId, payload: { agent, title: `${agent} at work`, ...policy } });

  return id;
}

async function written(input: Parameters<typeof appendEvent>[0]): Promise<bigint> {
  const result = await appendEvent(input);

  assert.ok(result.written, `${input.type} not written`);

  return result.event.seq;
}

describe('the last message of the main thread', () => {
  test('is null while the thread has none, then the newest message of its feed, of either side', async () => {
    const main = stand.mainThreadId;

    assert.equal(await readMainLastMessage(null), null);
    assert.equal(await readMainLastMessage(main), null);

    const asked = await written({ type: 'user.message', actor: 'user', userId: stand.userId, threadId: main, payload: { text: 'Start the designer', source: 'web' } });

    assert.equal((await readMainLastMessage(main))?.seq, asked);

    // A tool call after the message is not a message.
    await written({ type: 'tool.call.started', actor: 'agent', agentName: 'coordinator', userId: stand.userId, threadId: main, payload: { callId: 'c1', functionName: 'spawn_agent', input: {} } });
    assert.equal((await readMainLastMessage(main))?.seq, asked);

    const answered = await written({ type: 'agent.message', actor: 'agent', agentName: 'coordinator', userId: stand.userId, threadId: main, payload: { content: [{ type: 'text', text: 'Started.' }] } });
    const message = await readMainLastMessage(main);

    assert.equal(message?.seq, answered);
    assert.equal(message?.type, 'agent.message');
    assert.deepEqual(message?.payload, { content: [{ type: 'text', text: 'Started.' }] });

    // A child's report addressed to the main thread is in its feed too —
    // the same selection as GET /threads/:id/events.
    const child = await startChild('engineer');
    const reported = await written({ type: 'agent.message', actor: 'agent', agentName: 'engineer', userId: stand.userId, threadId: child, targetThreadId: main, payload: { content: [{ type: 'text', text: 'Done.' }] } });

    assert.equal((await readMainLastMessage(main))?.seq, reported);

    // A message inside the child alone is not the main thread's.
    await written({ type: 'agent.message', actor: 'agent', agentName: 'engineer', userId: stand.userId, threadId: child, payload: { content: [{ type: 'text', text: 'To myself.' }] } });
    assert.equal((await readMainLastMessage(main))?.seq, reported);
  });
});

describe('the threads of the api and their headless policy', () => {
  test('GET /threads/:id answers the thread with its policy; the list rows carry it too', async () => {
    const headless = await startChild('gardener', { headless: true });
    const surfaced = await startChild('engineer');

    const one = await stand.request('GET', `/api/threads/${headless}`);

    assert.equal(one.status, 200, one.text);

    const body = one.json<ThreadResponse & { headless?: boolean }>();

    assert.equal(body.thread.id, headless);
    assert.equal(body.thread.headless, true);
    assert.equal('headless' in body, false);
    assert.equal((await stand.request('GET', `/api/threads/${surfaced}`)).json<ThreadResponse>().thread.headless, false);

    const list = await stand.request('GET', '/api/threads?status=active&limit=50');

    assert.equal(list.status, 200, list.text);

    const rows = new Map(list.json<ThreadsResponse>().threads.map((t: Thread) => [t.id, t.headless]));

    assert.equal(rows.get(headless), true);
    assert.equal(rows.get(surfaced), false);
    assert.equal(rows.get(stand.mainThreadId), false);
  });

  test('a headless thread takes no message from the operator; a surfaced one does', async () => {
    const headless = await startChild('gardener', { headless: true });
    const surfaced = await startChild('engineer');

    const refused = await stand.request('POST', `/api/threads/${headless}/messages`, { body: { text: 'hello' } });

    assert.equal(refused.status, 409);
    assert.equal(refused.json<ErrorBody>().error.code, 'thread_headless');

    const taken = await stand.request('POST', `/api/threads/${surfaced}/messages`, { body: { text: 'hello' } });

    assert.equal(taken.status, 200, taken.text);
  });
});

describe('the agent catalog of the snapshot', () => {
  // The coordinator's model is the config's; the stand strips the OpenAI
  // variables, so the one the view reads is set here.
  const MODEL = 'gpt-test-model';

  before(() => {
    process.env.MAIN_OPENAI_MODEL = MODEL;
    loadAgents();
  });

  after(() => {
    delete process.env.MAIN_OPENAI_MODEL;
  });

  async function startedOn(threadId: string, agentName: string, model: string | null, userId: string = stand.userId): Promise<void> {
    await written({ type: 'session.started', actor: 'agent', agentName, userId, threadId, payload: { ...(model === null ? {} : { model }), tools: [], mcpServers: [] } });
  }

  test('heads the catalog with the coordinator: the OpenAI engine, the model of the config, its passport and every catalog agent', async () => {
    const [coordinator, ...catalog] = await readAgents(stand.userId);
    const names = getAgents().map(agent => agent.name);

    assert.ok(names.length > 0);
    assert.equal(coordinator.name, 'coordinator');
    assert.equal(coordinator.sdk, 'openai');
    assert.equal(coordinator.model, MODEL);
    assert.deepEqual(coordinator.tools, COORDINATOR_BUNDLE.declared);
    assert.deepEqual(coordinator.agents, names);
    assert.equal(coordinator.headless, false);
    assert.equal(coordinator.effort, null);
    assert.equal(coordinator.defaultEffort, null);
    assert.equal(coordinator.lastModel, null);
    assert.ok(coordinator.description.length > 0);
    assert.deepEqual(catalog.map(agent => agent.name), names);
  });

  test('gives every catalog agent the platform default effort beside the declared one, and the sdk of its declaration', async () => {
    const [, ...catalog] = await readAgents(stand.userId);
    const declared = new Map(getAgents().map(agent => [agent.name, agent]));

    for (const agent of catalog) {
      const decl = declared.get(agent.name)!;

      assert.equal(agent.defaultEffort, 'high', agent.name);
      assert.equal(agent.effort, decl.session?.effort ?? null, agent.name);
      assert.equal(agent.model, decl.session?.model ?? null, agent.name);
      assert.equal(agent.sdk, decl.sdk, agent.name);
    }
  });

  test('reads the model of each agent’s newest session.started in this workspace', async () => {
    const engineer = await startChild('engineer');
    const browser = await startChild('browser');
    const byName = async () => new Map((await readAgents(stand.userId)).map(agent => [agent.name, agent.lastModel]));

    assert.equal((await byName()).get('engineer'), null);

    await startedOn(engineer, 'engineer', 'claude-opus-5-5');
    await startedOn(browser, 'browser', 'claude-sonnet-5');
    assert.equal((await byName()).get('engineer'), 'claude-opus-5-5');
    assert.equal((await byName()).get('browser'), 'claude-sonnet-5');
    assert.equal((await byName()).get('gardener'), null);

    // The newest start wins; a start naming no model leaves the agent without one.
    const second = await startChild('engineer');

    await startedOn(second, 'engineer', 'claude-fable-5-1');
    assert.equal((await byName()).get('engineer'), 'claude-fable-5-1');

    const third = await startChild('browser');

    await startedOn(third, 'browser', null);
    assert.equal((await byName()).get('browser'), null);

    // Another workspace's session is not this one's.
    const foreign = randomUUID();

    await appendEvent({ type: 'thread.started', actor: 'system', userId: foreign, threadId: foreign, payload: { agent: 'gardener', title: 'elsewhere' } });
    await startedOn(foreign, 'gardener', 'claude-opus-5-5', foreign);
    assert.equal((await byName()).get('gardener'), null);
  });

  // The console's agents reducer folds the tail by the same rule
  // (startedModel over every session.started of a catalog agent); the
  // reducer itself is the console's (store.test.ts), the rule and the
  // tail are replayed here over the server's own reading.
  test('the replay of the tail over the snapshot equals the next snapshot', async () => {
    const lastModels = async () => Object.fromEntries((await readAgents(stand.userId)).map(agent => [agent.name, agent.lastModel]));
    // The stamp as buildSnapshot takes it (readHeadSeq): the head of the log before the projections.
    const asOfSeq = (await prisma.event.aggregate({ _max: { seq: true } }))._max.seq ?? 0n;
    const snapshot = await lastModels();
    const engineer = await startChild('engineer');
    const browser = await startChild('browser');
    const foreign = randomUUID();

    // A model, another agent's model, a start naming no model after a model,
    // an empty model, a start of an agent outside the catalog, a start of
    // another workspace — the tail of one window.
    await startedOn(engineer, 'engineer', 'claude-opus-5-5');
    await startedOn(browser, 'browser', 'claude-sonnet-5');
    await startedOn(engineer, 'engineer', null);
    await startedOn(browser, 'browser', '');
    await written({ type: 'session.started', actor: 'agent', agentName: 'nobody', userId: stand.userId, threadId: engineer, payload: { model: 'claude-opus-5-5', tools: [], mcpServers: [] } });
    await appendEvent({ type: 'thread.started', actor: 'system', userId: foreign, threadId: foreign, payload: { agent: 'gardener', title: 'elsewhere' } });
    await startedOn(foreign, 'gardener', 'claude-opus-5-5', foreign);
    await startedOn(engineer, 'engineer', 'claude-fable-5-1');

    // The tail as the stream serves it: after the snapshot's stamp, this
    // workspace's events (src/api/event-stream.ts visible).
    const tail = (await getEventsAfter(asOfSeq, { limit: 1000 })).filter(event => event.userId === stand.userId || event.userId === null);
    const replay = { ...snapshot };

    for (const event of tail) {
      if (event.type === 'session.started' && event.agentName && Object.hasOwn(replay, event.agentName)) {
        replay[event.agentName] = startedModel(event.payload);
      }
    }

    assert.ok(tail.length >= 8);
    assert.equal(replay.engineer, 'claude-fable-5-1');
    assert.equal(replay.browser, null);
    assert.equal(replay.gardener, null);
    assert.deepEqual(await lastModels(), replay);
  });
});

describe('the open requests for credentials of the snapshot', () => {
  // The tail of one window, this workspace's events, folded by the console's
  // rule (store/secret-requests): the row the bell shows.
  async function replayed(asOfSeq: bigint): Promise<Record<string, OpenSecretRequestView>> {
    const tail = (await getEventsAfter(asOfSeq, { limit: 1000 })).filter(event => event.userId === stand.userId || event.userId === null);
    const rows: Record<string, OpenSecretRequestView> = {};

    for (const event of tail) {
      if (event.type === 'secrets.requested' || event.type === 'oauth_client.requested') {
        const row = secretRequestFromRecord(event.type === 'secrets.requested' ? 'external-secrets' : 'oauth-client', event.payload as Partial<SecretRequestRecord>, event);

        if (row) {
          rows[row.id] = row;
        }
      } else if (event.type === 'secrets.provisioned' || event.type === 'oauth_client.provisioned') {
        const requestId = typeof event.payload.requestId === 'string' ? event.payload.requestId : null;

        for (const id of Object.keys(rows)) {
          if (id === requestId) {
            delete rows[id];
          }
        }
      }
    }

    return rows;
  }

  test('opens a request with its event in one transaction, authored by the issuing thread; issued again, it is the same row at the new moment', async () => {
    const asOfSeq = (await prisma.event.aggregate({ _max: { seq: true } }))._max.seq ?? 0n;
    const auth = await startChild('auth');

    assert.deepEqual(await readOpenSecretRequests(stand.userId), []);

    const keys = await openSecretRequest('external-secrets', { userId: stand.userId, threadId: auth, server: 'yandex-direct', fields: [{ key: 'API_KEY', description: 'd1' }, { key: 'LOGIN', description: 'd2' }] });
    const client = await openSecretRequest('oauth-client', { userId: stand.userId, threadId: auth, server: 'google' });
    const rows = await readOpenSecretRequests(stand.userId);

    assert.deepEqual(
      rows.map(row => [row.id, row.kind, row.server, row.fields, row.threadId, row.agent]),
      [
        [keys.id, 'external-secrets', 'yandex-direct', ['API_KEY', 'LOGIN'], auth, 'auth'],
        [client.id, 'oauth-client', 'google', ['client_id', 'client_secret'], auth, 'auth'],
      ],
    );

    const events = (await getEventsAfter(asOfSeq, { limit: 100 })).filter(event => event.type.endsWith('.requested'));

    assert.deepEqual(
      events.map(event => [event.type, event.actor, event.agentName, event.threadId, event.targetThreadId, event.payload]),
      [
        ['secrets.requested', 'agent', 'auth', auth, null, { requestId: keys.id, server: 'yandex-direct', fields: ['API_KEY', 'LOGIN'], requestedAt: rows[0].requestedAt.toISOString() }],
        ['oauth_client.requested', 'agent', 'auth', auth, null, { requestId: client.id, server: 'google', fields: ['client_id', 'client_secret'], requestedAt: rows[1].requestedAt.toISOString() }],
      ],
    );

    // Issued again from another thread: the same row (the link holds), the
    // new fields, the new thread and moment; the form still answers by the id.
    const other = await startChild('auth');
    const again = await openSecretRequest('external-secrets', { userId: stand.userId, threadId: other, server: 'yandex-direct', fields: [{ key: 'API_KEY', description: 'd1' }] });
    const after = await readOpenSecretRequests(stand.userId);
    const replaced = after.find(row => row.id === keys.id);

    assert.equal(again.id, keys.id);
    assert.ok(replaced);
    assert.deepEqual([replaced.fields, replaced.threadId], [['API_KEY'], other]);
    assert.ok(replaced.requestedAt.getTime() > rows[0].requestedAt.getTime());
    assert.deepEqual(after.map(row => row.id), [client.id, keys.id], 'the older moment first');

    const form = await stand.request('GET', `/api/secret-requests/${keys.id}`);

    assert.equal(form.status, 200, form.text);
    assert.deepEqual(form.json<SecretRequestResponse>().request.fields.map(field => field.key), ['API_KEY']);

    // The replay of the tail equals the rows (the bell after a reload equals the bell that stayed open).
    assert.deepEqual(await replayed(asOfSeq), Object.fromEntries((await readOpenSecretRequests(stand.userId)).map(row => [row.id, row])));
  });

  test('closes the request when the values land: the row is gone, the provisioned event names it', async () => {
    const asOfSeq = (await prisma.event.aggregate({ _max: { seq: true } }))._max.seq ?? 0n;
    const before = await readOpenSecretRequests(stand.userId);
    const keys = before.find(row => row.kind === 'external-secrets');
    const client = before.find(row => row.kind === 'oauth-client');

    assert.ok(keys && client);

    const saved = await stand.request('POST', `/api/secret-requests/${keys.id}`, { body: { values: { API_KEY: 'k' } } });

    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual((await readOpenSecretRequests(stand.userId)).map(row => row.id), [client.id]);

    const savedClient = await stand.request('POST', `/api/secret-requests/${client.id}`, { body: { values: { client_id: 'id', client_secret: '' } } });

    assert.equal(savedClient.status, 200, savedClient.text);
    assert.deepEqual(await readOpenSecretRequests(stand.userId), []);

    const events = (await getEventsAfter(asOfSeq, { limit: 100 })).filter(event => event.type.endsWith('.provisioned'));

    assert.deepEqual(
      events.map(event => [event.type, event.actor, event.targetThreadId, event.payload]),
      [
        ['secrets.provisioned', 'system', keys.threadId, { requestId: keys.id, server: 'yandex-direct', fields: ['API_KEY'] }],
        ['oauth_client.provisioned', 'system', client.threadId, { requestId: client.id, server: 'google', fields: ['client_id'] }],
      ],
    );
    assert.deepEqual(await replayed(asOfSeq), {});
    // The values stay out of the log.
    assert.ok(!JSON.stringify(events.map(event => event.payload)).includes('"k"'));
  });
});
