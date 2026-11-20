import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { startStand } from '../test-support/stand.ts';

test('written installation modules join the published tree and its consumers', async t => {
  const stand = await startStand();
  t.after(() => stand.stop());
  const { workspaceId, mainThreadId } = stand;
  const { startTree, catalog, installationNamesFor } = await import('./index.ts');
  const { coordinator } = await import('../../agents/access.ts');
  const { createCatalogPort } = await import('../harness/catalog-port.ts');
  const { catalogContext, grantKey } = await import('../harness/catalog-context.ts');
  const { getAccountService, getSecretService } = await import('../capabilities/connections/services.ts');
  const { prisma } = await import('../db/client.ts');

  const write = (file: string, body: string) => fs.writeFile('data/nodes/' + file + '.ts', body);
  await fs.mkdir('data/nodes', { recursive: true });
  await fs.mkdir('data/mcp-servers');
  await fs.writeFile('data/mcp-servers/wiki.json', JSON.stringify({ transport: 'http', auth: 'user', description: 'Wiki', url: 'https://wiki.test/mcp' }));
  const account = (service: string) => JSON.stringify({ type: 'account', service, summary: 'Read notes',
    oauth: { url: 'https://notes.test', clientRegistration: 'dynamic' } });
  const simple = (fields: string) => `export function define() { return { summary: 'Read notes', children: [], ${fields} }; }`;
  await write('bad_service', simple('connection: ' + account('gmail')));
  await write('bad_config', simple('connection: ' + account('wiki')));
  await write('bad_text', simple("summary: 'For example, an unknown text'"));
  await write('threads', simple('connection: ' + account('shadow')));
  await write('alpha', `export function define({ namedType, z, node }) {
    namedType('Reading', { description: 'A reading.' }, z.number());
    return { summary: 'Broken node', children: [
      node({ name: 'part', summary: 'Read notes', connection: ${account('partial')}, children: [] }),
      node({ name: 'part', summary: 'Duplicate part', children: [] }),
    ] };
  }`);
  await write('meter', `export function define({ namedType, capability, node, z, secretAuthority }) {
    const reading = namedType('Reading', { description: 'A meter reading.' }, z.strictObject({ amount: z.number() }));
    return { summary: 'Read a meter', recipients: ['general', 'meter_reader'], children: [
      node({ name: 'room', summary: 'Read a room meter', guide: [{ text: 'Read the meter in its room.' }],
        connection: { type: 'secret', service: 'room_meter', summary: 'Read a room meter', secrets: ['METER'] },
        children: [capability({ name: 'read', summary: 'Get a reading', description: 'Return the current reading.',
          input: z.strictObject({}), output: reading,
          run: (_, ctx) => ({ amount: secretAuthority(ctx).secrets.METER === 'fixture' ? 12 : 0 }) })] }),
      node({ name: 'notes', summary: 'Read notes', connection: ${account('meter_notes')}, children: [] }),
    ] };
  }`);
  await write('nightly', `export function define({ capability, z }) { return {
    summary: 'Read the nightly report', children: [capability({ name: 'read', summary: 'Read the report',
      description: 'Return the report.', input: z.strictObject({}), output: z.string(), run: () => 'ready' })],
  }; }`);
  const errors = t.mock.method(console, 'error', () => {});
  const warnings = t.mock.method(console, 'warn', () => {});
  const before = catalog();
  await startTree();

  await t.test('rejects collisions and invalid authored text before publishing services or types', () => {
    const messages = errors.mock.calls.map(call => call.arguments.join(' ')).join('\n');
    assert.match(messages, /alpha\.ts skipped:[\s\S]*two vertices share this full name/);
    assert.match(messages, /bad_service\.ts skipped:[\s\S]*already declared/);
    assert.match(messages, /bad_config\.ts skipped:.*wiki.*already configured/);
    assert.match(messages, /bad_text\.ts skipped:[\s\S]*carries an example/);
    assert.match(messages, /threads\.ts skipped:[\s\S]*two vertices share this full name/);
    assert.match(warnings.mock.calls.map(call => call.arguments.join(' ')).join('\n'), /nightly\.ts has no agent recipients/);
    assert.equal(getAccountService('partial'), null);
    assert.equal(getAccountService('shadow'), null);
    assert.equal(getAccountService('wiki')?.url, 'https://wiki.test/mcp');
    assert.equal(getAccountService('meter_notes')?.url, 'https://notes.test');
    assert.equal(getSecretService('room_meter')?.connected, false);
    assert.ok(!before.vertices.has('meter'));
    assert.ok(catalog().vertices.has('meter_room_read'));
    assert.ok(!catalog().vertices.has('alpha'));
  });

  const agent = { ...coordinator, access: { profile: 'general' } };
  const context = () => catalogContext(agent, workspaceId, mainThreadId);
  await t.test('recipients inherit the subtree, subject to each connection', async () => {
    assert.deepEqual(installationNamesFor(agent), ['meter']);
    assert.deepEqual(installationNamesFor(coordinator), []);
    assert.ok(!(await context()).grant.vertices.has('meter_room'));
    await prisma.externalServerSecret.create({ data: { server: 'room_meter', key: 'METER', value: 'fixture' } });
    const { grant } = await context();
    assert.ok(grant.vertices.has('meter_room_read'));
    assert.ok(!grant.vertices.has('meter_notes'));
    assert.ok(!grant.vertices.has('nightly'));
    assert.ok(!(await catalogContext(coordinator, workspaceId, mainThreadId)).grant.vertices.has('meter'));
    const named = await catalogContext({ ...coordinator, name: 'meter_reader' }, workspaceId, mainThreadId);
    assert.ok(named.grant.vertices.has('meter_room_read'));
    assert.equal(grantKey(grant), grantKey((await context()).grant));
  });

  await t.test('offline samples match independent first openings and leave the journal alone', async () => {
    for (const mode of ['function', 'signature'] as const) {
      const port = await createCatalogPort(agent, workspaceId, mainThreadId, mode);
      assert.doesNotMatch(port.instructions, /meter_room_read/);
      const count = await prisma.event.count();
      const samples = await Array.fromAsync(port.sampleOpenings());
      assert.equal(await prisma.event.count(), count);
      assert.ok(samples.some(sample => sample.name === ''));
      assert.ok(!samples.some(sample => sample.name === 'nightly'));
      const sample = samples.find(sample => sample.name === 'meter_room_read')!;
      assert.match(sample.result.text, /Read the meter in its room/);
      assert.match(sample.result.text, /Reading/);
      assert.equal(!!sample.result.definition, mode === 'function');
      const opened = await port.dispatch({ callId: crypto.randomUUID(), name: 'describe',
        arguments: JSON.stringify({ name: sample.name }) }, { seenNodes: new Set(), introduce: () => true });
      assert.deepEqual(sample.result, opened);
    }
    const port = await createCatalogPort(agent, workspaceId, mainThreadId, 'function');
    const callId = crypto.randomUUID();
    const result = await port.dispatch({ callId, name: 'meter_room_read', arguments: '{}' },
      { seenNodes: new Set(), introduce: () => true });
    assert.deepEqual(JSON.parse(result.text), { amount: 12 });
    const events = await prisma.event.findMany({ where: { payload: { path: ['callId'], equals: callId } }, orderBy: { seq: 'asc' } });
    assert.deepEqual(events.map(e => e.type), ['tool.call.started', 'tool.call.completed']);
    assert.doesNotMatch(JSON.stringify(events.map(e => e.payload)), /fixture/);
  });

  await t.test('a scheduled program calls a node with no agent recipients', async () => {
    const { fireTask } = await import('../schedule/engine.ts');
    const { isTaskRunning } = await import('../schedule/programs.ts');
    const task = await prisma.scheduledTask.create({ data: { slug: 'daily', name: 'Daily', workspaceId,
      kind: 'program', code: 'return await call("nightly_read", {})', wake: false, timeoutMs: 5000 } });
    const fired = await fireTask(task, 'cron');
    assert.ok(fired.kind === 'fired' && fired.runId);
    const deadline = Date.now() + 15000;
    while (isTaskRunning(task.slug) && Date.now() < deadline) await delay(25);
    const run = await prisma.scheduleRun.findUniqueOrThrow({ where: { id: fired.runId } });
    assert.equal(run.status, 'ok', JSON.stringify(run.error));
    assert.equal(run.value, 'ready');
    const completed = await prisma.event.findFirstOrThrow({ where: {
      type: 'tool.call.completed', actor: 'task', taskSlug: task.slug, taskRunId: run.id, threadId: mainThreadId,
    } });
    assert.equal((completed.payload as { functionName: string }).functionName, 'nightly_read');
  });
});
