import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { event, resetSeq } from '../../store/fixtures.ts';
import { projectFeed } from './project.ts';
import type { ActionsItem, ChildItem, FeedContext, MessageItem, PlanItem, SubtaskItem } from './project.ts';

const ctx: FeedContext = { threadId: 't1', agent: 'engineer', parentAgent: 'coordinator', agentOf: id => (id === 'c9' ? 'browser' : null) };

const own = (type: string, payload: object, extra: object = {}) => event({ type, threadId: 't1', payload: payload as never, ...extra });

describe('projectFeed — messages', () => {
  it('turns the task, user and agent messages into blocks with who → whom, folding a long task', () => {
    resetSeq(1n);

    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const items = projectFeed(
      [
        event({ type: 'thread.started', threadId: 't1', targetThreadId: 'main', agentName: 'coordinator', payload: { agent: 'engineer', input: long } }),
        event({ type: 'user.message', threadId: 't1', actor: 'user', payload: { text: 'hi', files: [{ fileId: 'f1', originalFilename: 'shot.png', contentType: 'image/png', sizeBytes: 1200 }] } }),
        own('agent.message', { content: [{ type: 'text', text: 'done' }, { type: 'image', fileId: 'f2' }, { type: 'resource_link', uri: 'https://x/y.md', name: 'y.md', size: 40 }] }),
        event({ type: 'thread.message', threadId: 't1', targetThreadId: 'main', payload: { text: 'to parent' } }),
        event({ type: 'thread.message', threadId: 'main', targetThreadId: 't1', agentName: 'coordinator', payload: { text: 'from parent' } }),
        event({ type: 'thread.message', threadId: 't1', targetThreadId: 'c9', payload: { text: 'to child' } }),
      ],
      ctx,
    );

    assert.deepEqual(
      items.map(item => item.kind),
      ['message', 'message', 'message', 'message', 'message', 'message'],
    );

    const [task, user, agent, toParent, fromParent, toChild] = items as MessageItem[];

    assert.equal(task!.from, 'coordinator');
    assert.equal(task!.to, 'engineer');
    assert.equal(task!.variant, 'task');
    assert.equal(task!.tag, 'task');
    assert.equal(task!.fold, true);

    assert.equal(user!.from, 'you');
    assert.equal(user!.variant, 'user');
    assert.deepEqual(user!.atts, [{ key: '2:0', href: '/api/files/f1', name: 'shot.png', image: true, size: 1200 }]);

    assert.equal(agent!.to, 'you');
    assert.equal(agent!.text, 'done');
    assert.equal(agent!.atts.length, 2);
    assert.equal(agent!.atts[0]!.image, true);
    assert.equal(agent!.atts[1]!.name, 'y.md');
    assert.equal(agent!.fold, false);

    assert.equal(toParent!.to, 'coordinator');
    assert.equal(fromParent!.from, 'coordinator');
    assert.equal(fromParent!.variant, 'task');
    assert.equal(toChild!.to, 'browser');
  });
});

describe('projectFeed — actions', () => {
  it('groups consecutive thinking and tool rows, pairs starts with ends, hides the plan tool', () => {
    resetSeq(10n);

    const t0 = new Date('2026-10-09T10:00:00Z');
    const items = projectFeed(
      [
        own('session.thinking', { text: 'hm' }, { createdAt: t0 }),
        own('session.tool.started', { toolUseId: 'u1', name: 'Bash', input: { command: 'npm test' } }, { createdAt: t0 }),
        own('session.tool.started', { toolUseId: 'u2', name: 'TodoWrite', input: { todos: [] } }),
        own('session.plan', { items: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] }),
        own('session.tool.completed', { toolUseId: 'u2', name: 'TodoWrite', result: 'ok', isError: false }),
        own('session.tool.completed', { toolUseId: 'u1', name: 'Bash', result: 'all green', isError: false, exitCode: 0 }, { createdAt: new Date(t0.getTime() + 4200) }),
        own('session.tool.started', { toolUseId: 'u3', name: 'Edit', input: { file_path: '/a/b/c/d.ts', old_string: 'x\ny', new_string: 'z' } }),
        own('session.tool.completed', { toolUseId: 'u3', name: 'Edit', result: 'edited', isError: true }),
        own('session.text', { text: 'now the tests' }),
        own('session.tool.started', { toolUseId: 'u4', name: 'Bash', input: { command: 'sleep 5' } }),
      ],
      ctx,
    );

    assert.deepEqual(
      items.map(item => item.kind),
      ['actions', 'plan', 'actions', 'quiet', 'actions'],
    );

    const first = items[0] as ActionsItem;

    assert.deepEqual(
      first.items.map(action => [action.label.text ?? action.label.tool, action.state, action.endNote]),
      [
        ['Thought', 'done', null],
        ['Bash', 'done', 'exit 0'],
      ],
    );
    assert.equal(first.items[0]!.untimed, true);
    assert.equal(first.items[1]!.endedAt!.getTime() - first.items[1]!.at.getTime(), 4200);
    assert.deepEqual(first.items[1]!.detail, { kind: 'terminal', command: 'npm test', output: 'all green' });

    const plan = items[1] as PlanItem;

    assert.deepEqual(plan.items, [{ text: 'a', state: 'done' }, { text: 'b', state: 'run' }, { text: 'c' }]);
    assert.equal(plan.done, 1);
    assert.equal(plan.total, 3);

    const edit = (items[2] as ActionsItem).items[0]!;

    assert.equal(edit.state, 'err');
    assert.equal(edit.endNote, 'error');
    assert.equal(edit.add, 1);
    assert.equal(edit.del, 2);
    assert.equal(edit.label.arg, '…/b/c/d.ts');
    assert.equal(edit.detail?.kind, 'diff');

    const running = (items[4] as ActionsItem).items[0]!;

    assert.equal(running.state, 'run');
    assert.equal(running.endedAt, null);
  });

  it('updates the plan in place and nests a sub-agent’s frames under its Agent row', () => {
    resetSeq(20n);

    const items = projectFeed(
      [
        own('session.plan', { items: [{ content: 'a', status: 'pending' }] }),
        own('session.tool.started', { toolUseId: 'ag', name: 'Agent', input: { description: 'find refs', prompt: 'grep it' } }),
        own('session.thinking', { text: 'sub', parentToolUseId: 'ag' }),
        own('session.tool.started', { toolUseId: 's1', name: 'Grep', input: { pattern: 'slug', path: '/src' }, parentToolUseId: 'ag' }),
        own('session.text', { text: 'found', parentToolUseId: 'ag' }),
        own('session.tool.completed', { toolUseId: 's1', name: 'Grep', result: '3 hits', isError: false, parentToolUseId: 'ag' }),
        own('session.plan', { items: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }),
        own('session.tool.completed', { toolUseId: 'ag', name: 'Agent', result: 'done', isError: false }),
      ],
      ctx,
    );

    assert.deepEqual(
      items.map(item => item.kind),
      ['plan', 'actions'],
    );

    const plan = items[0] as PlanItem;

    assert.deepEqual(plan.items, [{ text: 'a', state: 'done' }, { text: 'b' }]);
    assert.equal(plan.done, 1);

    const agent = (items[1] as ActionsItem).items[0]!;

    assert.equal(agent.label.tool, 'Agent');
    assert.equal(agent.state, 'done');
    assert.deepEqual(
      agent.nested.map(item => item.kind),
      ['actions', 'quiet'],
    );
    assert.deepEqual(
      (agent.nested[0] as ActionsItem).items.map(item => [item.label.text ?? item.label.tool, item.state]),
      [
        ['Thought', 'done'],
        ['Grep', 'done'],
      ],
    );
  });

  it('folds a batch summary over its preceding rows and pairs bridge calls by callId', () => {
    resetSeq(30n);

    const items = projectFeed(
      [
        own('session.tool.started', { toolUseId: 'r1', name: 'Read', input: { file_path: '/p/a.ts' } }),
        own('session.tool.completed', { toolUseId: 'r1', name: 'Read', result: 'a', isError: false }),
        own('session.tool.started', { toolUseId: 'r2', name: 'Read', input: { file_path: '/p/b.ts' } }),
        own('session.tool.completed', { toolUseId: 'r2', name: 'Read', result: 'b', isError: false }),
        own('session.tool.summary', { summary: 'Read 2 files in p', precedingToolUseIds: ['r1', 'r2'] }),
        own('tool.call.started', { callId: 'c1', functionName: 'get_event', input: { seq: 5 } }),
        own('tool.call.completed', { callId: 'c1', functionName: 'get_event', serverName: 'balabash', toolName: 'get_event', result: { content: [{ type: 'text', text: 'the event' }] } }),
        own('tool.call.started', { callId: 'c2', functionName: 'perplexity_ask', input: { q: 'x' } }),
        own('tool.call.failed', { callId: 'c2', functionName: 'perplexity_ask', error: 'boom' }),
      ],
      ctx,
    );

    assert.equal(items.length, 1);

    const rows = (items[0] as ActionsItem).items;

    assert.deepEqual(
      rows.map(row => [row.label.text ?? row.label.tool, row.depth ?? 0, row.state, row.endNote]),
      [
        ['Read 2 files in p', 0, 'done', '2 calls'],
        ['Read', 1, 'done', null],
        ['Read', 1, 'done', null],
        ['get_event', 0, 'done', null],
        ['perplexity_ask', 0, 'err', 'error'],
      ],
    );
    assert.deepEqual(rows[3]!.detail, { kind: 'io', input: '{\n  "seq": 5\n}', output: 'the event' });
    assert.equal(rows[4]!.detail?.kind === 'io' ? rows[4]!.detail.output : null, 'boom');
  });
});

describe('projectFeed — threads, tasks and lines', () => {
  it('keeps a child thread as one card from its start to its terminal, and a sub-agent task through its progress', () => {
    resetSeq(40n);

    const items = projectFeed(
      [
        event({ type: 'thread.started', threadId: 'c9', targetThreadId: 't1', agentName: 'browser', payload: { agent: 'browser', title: 'Check the page' } }),
        event({ type: 'thread.message', threadId: 'c9', targetThreadId: 't1', agentName: 'browser', payload: { text: 'question?' } }),
        own('session.tool.started', { toolUseId: 'b1', name: 'Bash', input: { command: 'npm test' } }),
        own('session.task.started', { taskId: 'k0', toolUseId: 'b1', description: 'Run the tests', backgrounded: false }),
        own('session.tool.completed', { toolUseId: 'b1', name: 'Bash', result: 'ok', isError: false, exitCode: 0 }),
        own('session.task.completed', { taskId: 'k0', toolUseId: 'b1', status: 'completed', summary: 'Run the tests' }),
        own('session.task.started', { taskId: 'k1', description: 'run tests', backgrounded: true }),
        own('session.task.progress', { taskId: 'k1', description: 'run tests', usage: { totalTokens: 6400, toolUses: 1, durationMs: 72_000 }, lastToolName: 'Bash' }),
        own('session.task.completed', { taskId: 'k1', status: 'failed', summary: 'tests failed', usage: { totalTokens: 9000, toolUses: 4, durationMs: 90_000 } }),
        event({ type: 'thread.completed', threadId: 'c9', targetThreadId: 't1', agentName: 'browser', payload: { title: 'Page checked', summary: { text: 'all fine' } } }),
      ],
      ctx,
    );

    assert.deepEqual(
      items.map(item => item.kind),
      ['child', 'message', 'actions', 'subtask'],
    );

    const child = items[0] as ChildItem;

    assert.equal(child.title, 'Page checked');
    assert.equal(child.state, 'done');
    assert.equal(child.summary, 'all fine');
    assert.notEqual(child.endedAt, null);

    const question = items[1] as MessageItem;

    assert.equal(question.from, 'browser');
    assert.equal(question.to, 'engineer');
    assert.equal(question.variant, undefined);

    const task = items[3] as SubtaskItem;

    assert.equal(task.taskKind, 'background task');
    assert.equal(task.state, 'err');
    assert.deepEqual(task.meta, ['9k tokens', '4 calls', '1:30']);
    assert.equal(task.lastTool, 'Bash');
    assert.equal(task.summary, 'tests failed');
  });

  it('draws the thread’s own terminals, notifications, compaction, retries and system events as lines', () => {
    resetSeq(50n);

    const items = projectFeed(
      [
        own('thread.progress', { text: 'stage 2' }),
        own('thread.notification', { text: 'urgent!', level: 'urgent' }, { actor: 'system' }),
        own('session.compaction', { trigger: 'auto', preTokens: 182_000, postTokens: 41_000 }),
        own('session.retry', { attempt: 2, maxRetries: 5, retryDelayMs: 8000, errorStatus: 529 }),
        own('session.state', { state: 'run' }),
        event({ type: 'thread.cancel', threadId: 'main', targetThreadId: 't1', agentName: 'coordinator', payload: { reason: 'enough' } }),
        event({ type: 'thread.cancelled', threadId: 't1', targetThreadId: 'main', actor: 'system', payload: { reason: 'enough', requestedBy: 'coordinator' } }),
        event({ type: 'system.exception', threadId: 't1', actor: 'system', payload: { error: 'TypeError' } }),
        event({ type: 'schedule.fired', targetThreadId: 't1', actor: 'system', payload: { slug: 's', name: 'Digest', count: 3 } }),
        event({ type: 'connection.reauthorization_required', targetThreadId: 't1', actor: 'system', payload: { server: 'gmail', account: 'default', name: 'gmail', error: 'expired' } }),
      ],
      ctx,
    );

    assert.deepEqual(
      items.map(item => (item.kind === 'sys' || item.kind === 'ev' ? [item.kind, item.text] : [item.kind, item.kind === 'error' ? item.title : ''])),
      [
        ['sys', 'stage 2'],
        ['sys', 'urgent!'],
        ['sys', 'Context compacted: 182k → 41k tokens'],
        ['ev', 'API error 529 · retry 2 of 5 in 8s'],
        ['sys', 'coordinator asked to cancel the thread — enough'],
        ['sys', 'Thread cancelled by coordinator — enough'],
        ['error', 'System exception'],
        ['sys', 'Task “Digest” fired · 3 new'],
        ['sys', 'gmail: sign-in required'],
      ],
    );
    assert.equal(items[1]!.kind === 'sys' ? items[1]!.level : null, 'urgent');
    assert.equal(items[8]!.kind === 'sys' ? items[8]!.state : null, 'act');
  });
});
