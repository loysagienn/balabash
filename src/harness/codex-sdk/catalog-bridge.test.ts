import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentDeclaration, RunContext, ThreadSummary } from '../../core/contract.ts';
import { startStand, type Stand } from '../../test-support/stand.ts';

const cli = fileURLToPath(new URL('../../test-support/codex-catalog-cli.mjs', import.meta.url));
let stand: Stand;
before(async () => {
  stand = await startStand();
  (await import('../../capabilities/agent-catalog.ts')).loadAgents();
  await (await import('../../tree/index.ts')).startTree();
});
after(() => stand.stop());

test('Codex samples preserve the first-opening guide and match structured MCP results', async t => {
  const { agent } = await import('../../../agents/codex.ts');
  const { createCodexPort } = await import('./catalog-bridge.ts');
  const { prisma } = await import('../../db/client.ts');
  const port = await createCodexPort(agent, stand.workspaceId, stand.mainThreadId);
  const client = new Client({ name: 'showcase-test', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await port.createServer().connect(local);
  await client.connect(remote);
  t.after(() => client.close());
  const count = await prisma.event.count();
  const samples = await Array.fromAsync(port.sampleOpenings());
  assert.equal(await prisma.event.count(), count);
  for (const name of ['projects_get', 'projects']) {
    const sample = samples.find(entry => entry.name === name);
    assert.ok(sample);
    const answer = await client.callTool({ name: 'describe', arguments: { name } });
    assert.deepEqual(sample.result, answer.structuredContent);
  }
});

// Drive the session runner and the real SDK subprocess/HTTP boundary. Only
// the CLI's conversation and the runner's outer message sink are scripted.
async function start(agent: AgentDeclaration, onText: (text: string) => Promise<void>) {
  const { workspaceId, mainThreadId } = stand;
  const { startThread } = await import('../../core/threads.ts');
  const { createCodexSession } = await import('./sdk-session.ts');
  const { createSessionRun } = await import('../../capabilities/session-run.ts');
  const headless = agent.defaultMode === 'headless';
  const { id: threadId } = await startThread({ workspaceId, parentThreadId: mainThreadId, agent: agent.name, headless, actor: 'system' });
  const controller = new AbortController();
  const reports: ThreadSummary[] = [];
  const ctx = {
    workspaceId, threadId, parentThreadId: mainThreadId, headless, signal: controller.signal,
    harness: { sdkSession: options => createCodexSession(options, { agent, workspaceId, threadId, cwd: stand.dir, codexPathOverride: cli }) },
    deliverTurnText: onText,
    complete: async summary => { reports.push(summary); },
  } satisfies Partial<RunContext>;
  const run = createSessionRun(agent, 'Begin', ctx as RunContext);
  return { run, reports, threadId, abort: () => controller.abort() };
}

test('a Codex run opens, calls, and resumes with a new grant and the reply from its catalog-spawned child', { timeout: 60_000 }, async t => {
  const { agent } = await import('../../../agents/codex.ts');
  const { prisma } = await import('../../db/client.ts');
  const { workspaceId } = stand;
  const { appendEvent } = await import('../../core/append.ts');
  const texts: string[] = [];
  const session = await start(agent, async text => {
    texts.push(text);
    if (texts.length === 1) {
      await prisma.connection.create({ data: { workspaceId, server: 'gmail', accountKey: 'work', displayName: 'Work', status: 'pending' } });
      const reply = await appendEvent({
        type: 'thread.message', workspaceId, threadId: text, targetThreadId: session.threadId,
        actor: 'agent', agentName: 'browser', payload: { text: 'Child reply' },
      });
      assert.ok(reply.written);
      session.run.accept(reply.event);
    }
  });
  t.after(session.abort);
  await session.run.finished;
  assert.equal(texts[1], 'Finished');
  assert.deepEqual(session.reports, [{ text: 'Finished' }]);
  const rows = await prisma.event.findMany({ where: { threadId: session.threadId, type: { startsWith: 'tool.call.' } }, orderBy: { seq: 'asc' } });
  const calls = rows.map(r => ({ type: r.type, agent: r.agentName, data: r.payload as Record<string, any> }));
  const starts = calls.filter(c => c.type === 'tool.call.started');
  assert.ok(starts.length > 0 && calls.every(c => c.agent === agent.name));
  assert.equal(new Set(starts.map(c => c.data.callId)).size, starts.length);
  for (const { data } of starts) assert.equal(calls.filter(c => c.data.callId === data.callId).length, 2);
  const program = calls.find(c => c.type === 'tool.call.completed' && c.data.functionName === 'run_program')!.data;
  assert.equal(program.value, 0);
  assert.ok(starts.some(c => c.data.functionName === 'projects_list' && c.data.runId === program.run.id));
  assert.equal(calls.find(c => c.type === 'tool.call.failed' && c.data.functionName === 'projects_get')!.data.error.kind, 'invalid_input');
  const opening = calls.find(c => c.type === 'tool.call.completed' && c.data.functionName === 'describe')!.data.value;
  assert.equal(opening.kind, 'capability');
  assert.equal(opening.guide, undefined);
});

test('the image generator exports, delivers and ends through its own catalog grant', { timeout: 60_000 }, async t => {
  const { agent } = await import('../../../agents/image_generator.ts');
  const { workspaceFilesDir } = await import('../../workspace/layout.ts');
  const { prisma } = await import('../../db/client.ts');
  await mkdir(workspaceFilesDir(stand.workspaceId), { recursive: true });
  await writeFile(path.join(workspaceFilesDir(stand.workspaceId), 'poster.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKc8AAAAASUVORK5CYII=', 'base64'));
  const texts: string[] = [];
  const session = await start(agent, async text => { texts.push(text); });
  t.after(session.abort);
  await session.run.finished;
  const message = await prisma.event.findFirstOrThrow({ where: { threadId: session.threadId, targetThreadId: stand.mainThreadId, type: 'thread.message' } });
  assert.deepEqual(texts, []);
  assert.deepEqual(session.reports, [{ text: 'Delivered', fileIds: (message.payload as { fileIds: string[] }).fileIds }]);
});
