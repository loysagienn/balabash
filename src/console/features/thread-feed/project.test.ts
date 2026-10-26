import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { event, resetSeq } from '../../store/fixtures.ts';
import { askDecidedWords, askKindTag, projectFeed } from './project.ts';
import type { ActionItem, ActionsItem, ChildItem, FeedContext, FeedItem, MessageItem, PlanItem, SubtaskItem, ThoughtItem } from './project.ts';

const ctx: FeedContext = { threadId: 't1', agent: 'engineer', parentAgent: 'coordinator', agentOf: id => (id === 'c9' ? 'browser' : null), userId: 'me', you: null };

const own = (type: string, payload: object, extra: object = {}) => event({ type, threadId: 't1', payload: payload as never, ...extra });

describe('projectFeed — a question for the user (agent.ask)', () => {
  it('is a card with the options while open, static with the outcome once resolved; a resolution without its card is a line', () => {
    resetSeq(1n);

    const items = projectFeed(
      [
        own('agent.ask', { askId: 'a1', kind: 'approval', text: 'POST /issues', link: 'https://x', options: ['allow', 'deny'] }, { agentName: 'fake_agent' }),
        own('agent.ask', { askId: 'c1', kind: 'credential', text: 'Connect GitHub', link: 'https://x/oauth', options: [] }, { agentName: 'fake_agent' }),
        event({ type: 'thread.decide', threadId: 'main', targetThreadId: 't1', actor: 'user', payload: { askId: 'a1', decision: 'allow', identity: { username: 'operator' } } }),
        own('agent.ask.resolved', { askId: 'a1', outcome: 'allow' }, { agentName: 'fake_agent' }),
        own('agent.ask.resolved', { askId: 'old', outcome: 'expired' }, { agentName: 'fake_agent' }),
      ],
      ctx,
    );

    // The decision draws no line of its own: the resolved card says it.
    assert.deepEqual(
      items.map(item => item.kind),
      ['message', 'message', 'sys'],
    );

    const [approval, signIn] = items as MessageItem[];

    assert.equal(approval.variant, 'ask');
    assert.equal(approval.from, 'fake_agent');
    assert.equal(approval.text, 'POST /issues');
    assert.deepEqual(approval.ask, { threadId: 't1', askId: 'a1', askKind: 'approval', options: ['allow', 'deny'], link: 'https://x', outcome: 'allow', decidedBy: null, decidedAt: null });
    assert.deepEqual(signIn.ask, { threadId: 't1', askId: 'c1', askKind: 'credential', options: [], link: 'https://x/oauth', outcome: null, decidedBy: null, decidedAt: null });
    assert.equal(items[2]!.kind === 'sys' ? items[2]!.text : null, 'Question resolved: expired');
    assert.equal(askDecidedWords(approval.ask!, new Date()), 'Closed in the external system: allow');
    assert.equal(askDecidedWords(signIn.ask!, new Date()), null);
    assert.equal(askKindTag('approval'), 'approval');
    assert.equal(askKindTag('credential'), 'sign-in');
    assert.equal(askKindTag('other'), 'question');
  });

  it('names who decided from Balabash — the operator by the name Settings holds, else the identity', () => {
    resetSeq(1n);

    const at = new Date(2026, 9, 9, 15, 45);
    const resolved = (you: string | null) =>
      (
        projectFeed(
          [
            own('agent.ask', { askId: 'a1', kind: 'approval', text: 'Apply?', options: ['Approve', 'Reject'] }, { agentName: 'fake_agent' }),
            own('agent.ask.resolved', { askId: 'a1', outcome: 'Approve', by: { identity: { username: 'operator' }, source: 'web' } }, { agentName: 'fake_agent', createdAt: at }),
          ],
          { ...ctx, you },
        )[0] as MessageItem
      ).ask!;

    assert.deepEqual(resolved('Vladimir'), { threadId: 't1', askId: 'a1', askKind: 'approval', options: ['Approve', 'Reject'], link: null, outcome: 'Approve', decidedBy: 'Vladimir', decidedAt: at });
    assert.equal(askDecidedWords(resolved('Vladimir'), at), 'Decided: Approve · Vladimir, 15:45');
    assert.equal(askDecidedWords(resolved(null), at), 'Decided: Approve · operator, 15:45');
  });
});

describe('projectFeed — messages', () => {
  it('shows another user’s message under their name as a person’s block; yours are "you"', () => {
    resetSeq(1n);

    const items = projectFeed(
      [
        event({ type: 'user.message', threadId: 't1', actor: 'user', payload: { text: 'hers', source: 'web', identity: { userId: 'u2', displayName: 'Ksenia' } } }),
        event({ type: 'user.message', threadId: 't1', actor: 'user', payload: { text: 'nameless', identity: { userId: 'u3', displayName: null, username: 'kate' } } }),
        event({ type: 'user.message', threadId: 't1', actor: 'user', payload: { text: 'mine', source: 'web', identity: { userId: 'me', displayName: 'Vladimir' } } }),
        event({ type: 'thread.cancel', threadId: 'main', targetThreadId: 't1', actor: 'user', payload: { reason: 'enough', identity: { userId: 'u2', displayName: 'Ksenia' } } }),
        event({ type: 'thread.interrupt', threadId: 'main', targetThreadId: 't1', actor: 'user', payload: { identity: { userId: 'me', displayName: 'Vladimir' } } }),
      ],
      { ...ctx, you: 'Vladimir' },
    );

    assert.deepEqual(
      items.map(item => (item.kind === 'message' ? [item.from, item.variant ?? null, item.text] : item.kind === 'sys' ? item.text : item.kind)),
      [
        ['Ksenia', 'user', 'hers'],
        ['kate', 'user', 'nameless'],
        ['you', 'user', 'mine'],
        'Ksenia asked to cancel the thread — enough',
        'Vladimir stopped the turn — the agent halted and is awaiting a message',
      ],
    );
  });

  it('shows a reply somebody else wrote into a remote session under their name, not as yours', () => {
    resetSeq(1n);

    const items = projectFeed(
      [
        event({ type: 'user.message', threadId: 't1', actor: 'user', payload: { text: 'from context', source: 'remote', identity: { username: 'alice' } } }),
        event({ type: 'user.message', threadId: 't1', actor: 'user', payload: { text: 'from nobody', source: 'remote' } }),
        event({ type: 'user.message', threadId: 't1', actor: 'user', payload: { text: 'mine', source: 'web' } }),
      ],
      ctx,
    ) as MessageItem[];

    assert.deepEqual(
      items.map(item => [item.from, item.variant ?? null, item.tag ?? null, item.text]),
      [
        ['alice', null, 'external', 'from context'],
        ['external', null, 'external', 'from nobody'],
        ['you', 'user', null, 'mine'],
      ],
    );
  });

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
    assert.deepEqual(user!.atts, [{ key: '2:0', href: '/api/files/f1', fileId: 'f1', name: 'shot.png', image: true, size: 1200 }]);

    assert.equal(agent!.to, 'you');
    assert.equal(agent!.text, 'done');
    assert.deepEqual(agent!.atts, [
      { key: '3:1', href: '/api/files/f2', fileId: 'f2', name: null, image: true, size: null },
      { key: '3:2', href: 'https://x/y.md', fileId: null, name: 'y.md', image: false, size: 40 },
    ]);
    assert.equal(agent!.fold, false);

    assert.equal(toParent!.to, 'coordinator');
    assert.equal(fromParent!.from, 'coordinator');
    assert.equal(fromParent!.variant, 'task');
    assert.equal(toChild!.to, 'browser');
  });

  it('folds a long message between agents, never the user’s message or the agent’s answer to the user', () => {
    resetSeq(1n);

    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const items = projectFeed(
      [
        event({ type: 'user.message', threadId: 't1', actor: 'user', payload: { text: long } }),
        own('agent.message', { content: [{ type: 'text', text: long }] }),
        event({ type: 'thread.message', threadId: 't1', targetThreadId: 'main', payload: { text: long } }),
        event({ type: 'thread.message', threadId: 'main', targetThreadId: 't1', agentName: 'coordinator', payload: { text: long } }),
      ],
      ctx,
    );

    assert.deepEqual(
      (items as MessageItem[]).map(item => item.fold),
      [false, false, true, true],
    );
  });

  it('names the attachments by the facts the event recorded, and leaves the ones recorded by id alone to the meta', () => {
    resetSeq(1n);

    const items = projectFeed(
      [
        own('agent.message', { content: [{ type: 'file', fileId: 'f1', name: 'voucher.pdf', mimeType: 'application/pdf', size: 2048 }, { type: 'image', fileId: 'f2', name: 'shot.png', mimeType: 'image/png', size: 9 }] }),
        // Telegram: a photo without a filename — files carry the type and the size.
        event({ type: 'user.message', threadId: 't1', actor: 'user', payload: { text: null, files: [{ fileId: 'f3', contentType: 'image/jpeg', originalFilename: null, sizeBytes: 77 }] } }),
        // A child's reply with files: fileIds for the model, files for the reader.
        event({ type: 'thread.message', threadId: 'c9', targetThreadId: 't1', agentName: 'browser', payload: { text: 'the page', fileIds: ['f4'], files: [{ fileId: 'f4', contentType: 'image/png', originalFilename: 'page.png', sizeBytes: 5 }] } }),
        // History before the facts: fileIds alone.
        event({ type: 'thread.message', threadId: 't1', targetThreadId: 'main', payload: { text: 'to parent', fileIds: ['f5', 'f6'] } }),
      ],
      ctx,
    );
    const [agent, user, fromChild, toParent] = items as MessageItem[];

    assert.deepEqual(agent!.atts, [
      { key: '1:0', href: '/api/files/f1', fileId: 'f1', name: 'voucher.pdf', image: false, size: 2048 },
      { key: '1:1', href: '/api/files/f2', fileId: 'f2', name: 'shot.png', image: true, size: 9 },
    ]);
    assert.deepEqual(user!.atts, [{ key: '2:0', href: '/api/files/f3', fileId: 'f3', name: null, image: true, size: 77 }]);
    assert.deepEqual(fromChild!.atts, [{ key: '3:0', href: '/api/files/f4', fileId: 'f4', name: 'page.png', image: true, size: 5 }]);
    assert.deepEqual(toParent!.atts, [
      { key: '4:0', href: '/api/files/f5', fileId: 'f5', name: null, image: false, size: null },
      { key: '4:1', href: '/api/files/f6', fileId: 'f6', name: null, image: false, size: null },
    ]);
  });
});

describe('projectFeed — actions', () => {
  it('a thought is text in the feed: a measured one began durationMs before its event and carries the duration, an unmeasured one none', () => {
    resetSeq(10n);

    const t0 = new Date('2026-10-09T10:00:00Z');
    const items = projectFeed(
      [
        own('session.thinking', { text: 'long', durationMs: 14_000 }, { createdAt: t0 }),
        own('session.thinking', { text: 'instant', durationMs: 0 }, { createdAt: t0 }),
        own('session.thinking', { text: 'old history' }, { createdAt: t0 }),
        own('session.thinking', { text: 'nonsense', durationMs: -5 }, { createdAt: t0 }),
      ],
      ctx,
    ) as ThoughtItem[];

    assert.deepEqual(
      items.map(item => [item.kind, item.text, item.durationMs]),
      [
        ['thought', 'long', 14_000],
        ['thought', 'instant', 0],
        ['thought', 'old history', null],
        ['thought', 'nonsense', null],
      ],
    );
    assert.equal(items[0]!.at.getTime(), t0.getTime() - 14_000);
    assert.equal(items[1]!.at.getTime(), t0.getTime());
    assert.equal(items[3]!.at.getTime(), t0.getTime());
  });

  it('a thought ends one action group and starts the next; a thought without text is not shown and splits nothing', () => {
    resetSeq(10n);

    const tool = (id: string) => [
      own('session.tool.started', { toolUseId: id, name: 'Bash', input: { command: id } }),
      own('session.tool.completed', { toolUseId: id, name: 'Bash', result: '', isError: false, exitCode: 0 }),
    ];
    const items = projectFeed(
      [
        ...tool('a'),
        own('session.thinking', { text: 'between', durationMs: 2000 }),
        ...tool('b'),
        own('session.thinking', { text: '' }),
        own('session.thinking', { text: '  \n ' }),
        ...tool('c'),
        own('session.thinking', { text: 'at the end' }),
      ],
      ctx,
    );

    assert.deepEqual(
      items.map(item => (item.kind === 'actions' ? item.items.map(row => row.label.arg) : item.kind === 'thought' ? ['thought', item.text] : [item.kind])),
      [['a'], ['thought', 'between'], ['b', 'c'], ['thought', 'at the end']],
    );
  });

  it('groups consecutive tool rows, pairs starts with ends, hides the plan tool', () => {
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
      ['thought', 'actions', 'plan', 'actions', 'quiet', 'actions'],
    );

    const first = items[1] as ActionsItem;

    assert.deepEqual(
      first.items.map(action => [action.label.text ?? action.label.tool, action.state, action.endNote]),
      [['Bash', 'done', 'exit 0']],
    );
    assert.equal(first.items[0]!.endedAt!.getTime() - first.items[0]!.at.getTime(), 4200);
    assert.deepEqual(first.items[0]!.detail, { kind: 'terminal', command: 'npm test', output: 'all green' });

    const plan = items[2] as PlanItem;

    assert.deepEqual(plan.items, [{ text: 'a', state: 'done' }, { text: 'b', state: 'run' }, { text: 'c' }]);
    assert.equal(plan.done, 1);
    assert.equal(plan.total, 3);

    const edit = (items[3] as ActionsItem).items[0]!;

    assert.equal(edit.state, 'err');
    assert.equal(edit.endNote, 'error');
    assert.equal(edit.add, 1);
    assert.equal(edit.del, 2);
    assert.equal(edit.label.arg, '…/b/c/d.ts');
    assert.equal(edit.detail?.kind, 'diff');

    const running = (items[5] as ActionsItem).items[0]!;

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
    // The thought is text under the row too, and it splits the frames the same way.
    assert.deepEqual(
      agent.nested.map(item => item.kind),
      ['thought', 'actions', 'quiet'],
    );
    assert.equal((agent.nested[0] as ThoughtItem).text, 'sub');
    assert.deepEqual(
      (agent.nested[1] as ActionsItem).items.map(item => [item.label.text ?? item.label.tool, item.state]),
      [['Grep', 'done']],
    );
  });

  it('keeps a sub-agent’s frames off the feed while its Agent row is before the loaded range, its report where it finished', () => {
    resetSeq(200n);

    // Older: the Agent row and its task; newer: the chunk the thread opens with.
    const older = [
      own('session.tool.started', { toolUseId: 'ag', name: 'Agent', input: { description: 'Map attachments', prompt: 'trace it', run_in_background: true } }),
      own('session.task.started', { taskId: 'tk', toolUseId: 'ag', description: 'Map attachments', backgrounded: true, subagentType: 'Explore' }),
      own('session.tool.completed', { toolUseId: 'ag', name: 'Agent', result: 'Async agent launched', isError: false }),
      own('session.thinking', { text: 'where to start', parentToolUseId: 'ag' }),
    ];
    const report = `I traced the whole path.\n\n${'## Section\n\nA finding with detail.\n\n'.repeat(400)}`;
    const running = [
      own('session.tool.started', { toolUseId: 's1', name: 'Grep', input: { pattern: 'fileId', path: '/src' }, parentToolUseId: 'ag' }),
      own('session.tool.started', { toolUseId: 'm1', name: 'Bash', input: { command: 'ls' } }),
      own('session.tool.completed', { toolUseId: 's1', name: 'Grep', result: '40 hits', isError: false, parentToolUseId: 'ag' }),
      own('session.task.progress', { taskId: 'tk', toolUseId: 'ag', description: 'Running grep', usage: { totalTokens: 9000, toolUses: 1, durationMs: 4000 }, lastToolName: 'Grep' }),
      own('session.tool.completed', { toolUseId: 'm1', name: 'Bash', result: 'a b', isError: false, exitCode: 0 }),
      own('session.text', { text: 'Now the CCR adapter.', parentToolUseId: 'ag' }),
      own('session.text', { text: 'Waiting for the sub-agent.', parentToolUseId: null }),
    ];
    const finished = [
      own('session.text', { text: report, parentToolUseId: 'ag' }),
      own('session.task.completed', { taskId: 'tk', toolUseId: 'ag', status: 'completed', summary: report, usage: { totalTokens: 123_000, toolUses: 47, durationMs: 187_000 } }),
      // A shell task's end carries no usage: no report.
      own('session.task.completed', { taskId: 'sh', toolUseId: 'm1', status: 'completed', summary: 'Background command finished' }),
    ];

    // Streaming, the Agent row out of range: the thread's own row and text
    // only — the sub-agent's call, thought and words are not drawn.
    const live = projectFeed(running, ctx);

    assert.deepEqual(
      live.map(item => item.kind),
      ['actions', 'quiet'],
    );
    assert.deepEqual(
      (live[0] as ActionsItem).items.map(row => row.label.tool),
      ['Bash'],
    );
    assert.equal((live[1] as { text: string }).text, 'Waiting for the sub-agent.');

    // It finished: one collapsed row with the whole report, no description
    // to name it by.
    const ended = projectFeed([...running, ...finished], ctx);

    assert.deepEqual(
      ended.map(item => item.kind),
      ['actions', 'quiet', 'actions'],
    );

    const row = (ended[2] as ActionsItem).items[0]!;

    assert.deepEqual([row.label.icon, row.label.text, row.label.textArg, row.state, row.endNote, row.untimed], ['bot', 'Subagent report', undefined, 'done', null, true]);
    assert.deepEqual(row.detail, { kind: 'report', text: report });
    assert.equal((ended[2] as ActionsItem).items.length, 1);

    // The older chunk loads: the frames go under the Agent row, the report
    // row stays the same row in the same place, now with its description.
    const whole = projectFeed([...older, ...running, ...finished], ctx);

    assert.deepEqual(
      whole.map(item => item.kind),
      ['actions', 'subtask', 'actions', 'quiet', 'actions'],
    );

    const agent = (whole[0] as ActionsItem).items[0]!;

    assert.equal(agent.label.tool, 'Agent');
    assert.deepEqual(
      agent.nested.map(item => item.kind),
      ['thought', 'actions', 'quiet', 'quiet'],
    );
    assert.deepEqual(
      (agent.nested[1] as ActionsItem).items.map(item => item.label.text ?? item.label.tool),
      ['Grep'],
    );
    // Under the row the report closes the sub-agent's frames, whole.
    assert.equal((agent.nested[3] as { text: string }).text, report);

    const again = (whole[4] as ActionsItem).items[0]!;

    assert.equal(again.key, row.key);
    assert.equal(again.label.textArg, 'Map attachments');
  });

  it('keeps the tasks of a sub-agent’s own calls off the feed while its Agent row is out of range, and a nested sub-agent’s report under its parent', () => {
    resetSeq(240n);

    const frames = [
      // The sub-agent's own Bash, announced as a task, and a sub-agent it ran.
      own('session.tool.started', { toolUseId: 'sb', name: 'Bash', input: { command: 'sleep 60', description: 'Wait for the crawler' }, parentToolUseId: 'ag' }),
      own('session.task.started', { taskId: 'kb', toolUseId: 'sb', description: 'Wait for the crawler', backgrounded: false }),
      own('session.task.completed', { taskId: 'kb', toolUseId: 'sb', status: 'completed', summary: 'Wait for the crawler' }),
      own('session.tool.completed', { toolUseId: 'sb', name: 'Bash', result: '', isError: false, exitCode: 0, parentToolUseId: 'ag' }),
      own('session.tool.started', { toolUseId: 'in', name: 'Agent', input: { description: 'Inner look', prompt: 'look' }, parentToolUseId: 'ag' }),
      own('session.task.started', { taskId: 'ki', toolUseId: 'in', description: 'Inner look', backgrounded: false, subagentType: 'Explore' }),
      own('session.task.completed', { taskId: 'ki', toolUseId: 'in', status: 'completed', summary: 'inner findings', usage: { totalTokens: 1000, toolUses: 2, durationMs: 3000 } }),
      own('session.tool.completed', { toolUseId: 'in', name: 'Agent', result: 'inner findings', isError: false, parentToolUseId: 'ag' }),
    ];

    assert.deepEqual(projectFeed(frames, ctx), []);

    resetSeq(230n);

    const start = own('session.tool.started', { toolUseId: 'ag', name: 'Agent', input: { description: 'Outer', prompt: 'go' } });
    const items = projectFeed([start, ...frames], ctx);

    assert.deepEqual(
      items.map(item => item.kind),
      ['actions'],
    );

    const outer = (items[0] as ActionsItem).items[0]!;
    const nested = outer.nested.flatMap((item): (FeedItem | ActionItem)[] => (item.kind === 'actions' ? item.items : [item]));

    assert.deepEqual(
      nested.map(item => (item.kind === 'action' ? (item.label.text ?? item.label.tool) : item.kind)),
      ['Bash', 'Agent', 'subtask', 'Subagent report'],
    );
  });

  it('lets the report of a sub-agent the thread waited on stand for the end of its Agent call', () => {
    resetSeq(260n);

    const items = projectFeed(
      [
        own('session.tool.started', { toolUseId: 'v1', name: 'Read', input: { file_path: '/shot.png' }, parentToolUseId: 'fg' }),
        own('session.tool.completed', { toolUseId: 'v1', name: 'Read', result: 'image', isError: false, parentToolUseId: 'fg' }),
        own('session.text', { text: 'Canvas checked.', parentToolUseId: 'fg' }),
        own('session.task.completed', { taskId: 'vt', toolUseId: 'fg', status: 'completed', summary: 'Canvas checked.', usage: { totalTokens: 50_000, toolUses: 13, durationMs: 90_000 } }),
        own('session.tool.completed', { toolUseId: 'fg', name: 'Agent', result: [{ type: 'text', text: 'Canvas checked.' }], isError: false }),
        // A continuation through SendMessage, its row loaded: named by its task.
        own('session.task.started', { taskId: 'vt', toolUseId: 'sm', description: 'Verify the canvas', backgrounded: true, subagentType: 'design-verifier' }),
        own('session.tool.started', { toolUseId: 'sm', name: 'SendMessage', input: { to: 'vt', message: 'check again' } }),
        own('session.tool.completed', { toolUseId: 'sm', name: 'SendMessage', result: 'sent', isError: false }),
        own('session.task.completed', { taskId: 'vt', toolUseId: 'sm', status: 'completed', summary: 'All fixed.', usage: { totalTokens: 60_000, toolUses: 15, durationMs: 120_000 } }),
      ],
      ctx,
    );
    const rows = items.flatMap(item => (item.kind === 'actions' ? item.items : []));

    assert.deepEqual(
      rows.map(row => [row.label.text ?? row.label.tool, row.label.textArg]),
      [
        ['Subagent report', undefined],
        ['SendMessage', undefined],
        ['Subagent report', 'Verify the canvas'],
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

  it('shows the structured content of a bridge result that carries no content blocks, and the message of a structured error', () => {
    resetSeq(35n);

    const items = projectFeed(
      [
        own('tool.call.started', { callId: 'c1', functionName: 'get_event', input: { seq: 5 } }),
        own('tool.call.completed', { callId: 'c1', functionName: 'get_event', serverName: 'balabash', toolName: 'get_event', result: { content: [], structuredContent: { text: 'important result' } } }),
        own('tool.call.started', { callId: 'c2', functionName: 'get_thread', input: { threadId: 'nope' } }),
        own('tool.call.completed', { callId: 'c2', functionName: 'get_thread', serverName: 'balabash', toolName: 'get_thread', result: { content: [], structuredContent: { error: { message: 'thread not found', details: { threadId: 'nope' } } }, isError: true } }),
      ],
      ctx,
    );
    const rows = (items[0] as ActionsItem).items;
    const output = (row: (typeof rows)[number]) => (row.detail?.kind === 'io' ? row.detail.output : null);

    assert.equal(rows[0]!.state, 'done');
    assert.equal(output(rows[0]!), '{\n  "text": "important result"\n}');
    assert.equal(rows[1]!.state, 'err');
    assert.equal(output(rows[1]!), 'thread not found\n{\n  "threadId": "nope"\n}');
  });

  it('keeps the refusal of a failed file change next to the requested diff', () => {
    resetSeq(37n);

    const items = projectFeed(
      [
        own('session.tool.started', { toolUseId: 'e1', name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }),
        own('session.tool.completed', { toolUseId: 'e1', name: 'Edit', result: 'Permission denied: a.ts', isError: true }),
        own('session.tool.started', { toolUseId: 'w1', name: 'Write', input: { file_path: 'b.ts', content: 'z' } }),
        own('session.tool.completed', { toolUseId: 'w1', name: 'Write', result: 'File written', isError: false }),
      ],
      ctx,
    );
    const [edit, write] = (items[0] as ActionsItem).items;

    assert.equal(edit!.state, 'err');
    assert.deepEqual(edit!.detail, { kind: 'diff', diff: '--- a.ts\n+++ a.ts\n-x\n+y', error: 'Permission denied: a.ts' });
    assert.deepEqual(write!.detail, { kind: 'diff', diff: '--- b.ts\n+++ b.ts\n+z' });
  });

  it('draws an end whose start lies before the loaded range: a tool row, a child card, a task card', () => {
    resetSeq(38n);

    const items = projectFeed(
      [
        own('session.tool.completed', { toolUseId: 'a', name: 'Bash', result: 'command failed', isError: true, exitCode: 1 }),
        own('session.tool.completed', { toolUseId: 'p', name: 'TodoWrite', result: 'ok', isError: false }),
        event({ type: 'thread.completed', threadId: 'c9', targetThreadId: 't1', agentName: 'browser', payload: { title: 'Page checked', summary: { text: 'all fine' } } }),
        own('session.task.completed', { taskId: 'task1', status: 'failed', summary: 'background task failed' }),
        own('session.task.completed', { taskId: 'task2', toolUseId: 'b', status: 'completed', summary: 'Run the tests' }),
      ],
      ctx,
    );

    assert.deepEqual(
      items.map(item => item.kind),
      ['actions', 'child', 'subtask'],
    );

    const row = (items[0] as ActionsItem).items[0]!;

    assert.equal(row.label.tool, 'Bash');
    assert.equal(row.state, 'err');
    assert.equal(row.endNote, 'exit 1');
    assert.equal(row.untimed, true);
    assert.deepEqual(row.detail, { kind: 'io', input: '', output: 'command failed' });

    const child = items[1] as ChildItem;

    assert.equal(child.agent, 'browser');
    assert.equal(child.title, 'Page checked');
    assert.equal(child.state, 'done');
    assert.equal(child.summary, 'all fine');
    assert.equal(child.startedAt, null);

    const task = items[2] as SubtaskItem;

    assert.equal(task.state, 'err');
    assert.equal(task.description, 'background task failed');
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
      ['child', 'message', 'actions', 'subtask', 'actions'],
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

    // An agent's task (the harness reports its usage) also leaves its
    // report where it ended.
    const report = (items[4] as ActionsItem).items[0]!;

    assert.deepEqual([report.label.text, report.label.textArg, report.state, report.endNote], ['Subagent report', 'run tests', 'err', 'failed']);
  });

  it('names a backgrounded sub-agent by its agent and keeps one card through a repeated announcement of the task', () => {
    resetSeq(60n);

    const items = projectFeed(
      [
        own('session.tool.started', { toolUseId: 'ag', name: 'Agent', input: { description: 'Data gaps', prompt: 'look', run_in_background: true } }),
        own('session.task.started', { taskId: 'bg', toolUseId: 'ag', description: 'Data gaps', backgrounded: true, subagentType: 'general-purpose' }),
        own('session.tool.completed', { toolUseId: 'ag', name: 'Agent', result: 'started', isError: false }),
        own('session.task.progress', { taskId: 'bg', toolUseId: 'ag', description: 'Reading', usage: { totalTokens: 15_000, toolUses: 1, durationMs: 2_000 }, lastToolName: 'Read' }),
        own('session.task.completed', { taskId: 'bg', status: 'completed', summary: 'first word', usage: { totalTokens: 77_000, toolUses: 33, durationMs: 382_000 } }),
        // The harness announces the task again when its late output arrives.
        own('session.task.started', { taskId: 'bg', toolUseId: 'ag', description: 'Data gaps', backgrounded: true, subagentType: 'general-purpose' }),
      ],
      ctx,
    );

    assert.deepEqual(
      items.map(item => item.kind),
      ['actions', 'subtask', 'actions'],
    );

    const task = items[1] as SubtaskItem;

    assert.equal(task.taskKind, 'general-purpose subagent');
    assert.deepEqual((items[2] as ActionsItem).items[0]!.detail, { kind: 'report', text: 'first word' });
    assert.equal(task.state, 'run');
    assert.equal(task.summary, 'first word');
    assert.deepEqual(task.meta, ['77k tokens', '33 calls', '6:22']);

    const done = projectFeed(
      [
        own('session.task.started', { taskId: 'bg', description: 'Data gaps', backgrounded: true, subagentType: 'general-purpose' }),
        own('session.task.completed', { taskId: 'bg', status: 'completed', summary: 'first word', usage: { totalTokens: 77_000, toolUses: 33, durationMs: 382_000 } }),
        own('session.task.started', { taskId: 'bg', description: 'Data gaps', backgrounded: true, subagentType: 'general-purpose' }),
        own('session.task.completed', { taskId: 'bg', status: 'completed', summary: 'the late output', usage: { totalTokens: 78_000, toolUses: 33, durationMs: 492_000 } }),
        own('session.task.started', { taskId: 'sh', description: 'npm test', backgrounded: true }),
      ],
      ctx,
    );

    assert.deepEqual(
      done.map(item => item.kind),
      ['subtask', 'actions', 'subtask'],
    );
    // Each run of the sub-agent brought its own report.
    assert.deepEqual(
      (done[1] as ActionsItem).items.map(row => (row.detail?.kind === 'report' ? row.detail.text : null)),
      ['first word', 'the late output'],
    );
    assert.equal((done[0] as SubtaskItem).state, 'done');
    assert.equal((done[0] as SubtaskItem).summary, 'the late output');
    assert.deepEqual((done[0] as SubtaskItem).meta, ['78k tokens', '33 calls', '8:12']);
    assert.equal((done[2] as SubtaskItem).taskKind, 'background task');
  });

  it('keeps one card when the loaded range opens between the first start and the first end of a task announced again', () => {
    resetSeq(70n);

    // The chunk begins after the first started: the first completed alone
    // makes the card, the second announcement runs it again where it is.
    const events = [
      own('session.task.completed', { taskId: 'bg', status: 'completed', summary: 'first word', usage: { totalTokens: 77_000, toolUses: 33, durationMs: 382_000 } }),
      own('session.task.started', { taskId: 'bg', description: 'Data gaps', backgrounded: true, subagentType: 'general-purpose' }),
    ];
    const running = projectFeed(events, ctx);

    assert.deepEqual(
      running.map(item => item.kind),
      ['subtask', 'actions'],
    );

    const card = running[0] as SubtaskItem;

    assert.equal(card.taskKind, 'general-purpose subagent');
    assert.equal(card.state, 'run');
    assert.equal(card.description, 'Data gaps');
    assert.equal(card.summary, 'first word');
    assert.deepEqual(card.meta, ['77k tokens', '33 calls', '6:22']);

    resetSeq(70n);

    const done = projectFeed(
      [...events, own('session.task.completed', { taskId: 'bg', status: 'completed', summary: 'the late output', usage: { totalTokens: 78_000, toolUses: 33, durationMs: 492_000 } })],
      ctx,
    );

    assert.deepEqual(
      done.map(item => item.kind),
      ['subtask', 'actions'],
    );
    assert.equal((done[0] as SubtaskItem).state, 'done');
    assert.equal((done[0] as SubtaskItem).description, 'Data gaps');
    assert.equal((done[0] as SubtaskItem).summary, 'the late output');
    assert.deepEqual((done[0] as SubtaskItem).meta, ['78k tokens', '33 calls', '8:12']);

    // The end alone, unannounced again, reads as before: its summary for
    // the description.
    resetSeq(70n);

    const alone = projectFeed(events.slice(0, 1), ctx);

    assert.equal((alone[0] as SubtaskItem).taskKind, 'task');
    assert.equal((alone[0] as SubtaskItem).description, 'first word');
    assert.equal((alone[0] as SubtaskItem).summary, null);
  });

  it('the thread’s own terminal ends every row still running — a tool, a bridge call, a task — without an outcome', () => {
    resetSeq(10n);

    const t0 = new Date('2026-10-10T14:22:00Z');
    const end = new Date(t0.getTime() + 9000);
    const run = (terminal: string, payload: object) =>
      projectFeed(
        [
          own('session.tool.started', { toolUseId: 'u1', name: 'Shell', input: { command: 'ls' } }, { createdAt: t0 }),
          own('session.tool.completed', { toolUseId: 'u1', name: 'Shell', result: '', isError: false, exitCode: 0 }, { createdAt: new Date(t0.getTime() + 1000) }),
          // The end of this one never reached the log.
          own('session.tool.started', { toolUseId: 'u2', name: 'Shell', input: { command: 'python3 probe.py' } }, { createdAt: new Date(t0.getTime() + 2000) }),
          own('tool.call.started', { callId: 'c1', functionName: 'get_event', input: { seq: 1 } }, { createdAt: new Date(t0.getTime() + 3000) }),
          own('session.task.started', { taskId: 'k1', description: 'search', backgrounded: true }, { createdAt: new Date(t0.getTime() + 4000) }),
          event({ type: terminal, threadId: 't1', targetThreadId: 'main', payload: payload as never, createdAt: end }),
        ],
        ctx,
      );

    const items = run('thread.completed', { title: 'Done', summary: { text: 'ok' } });

    assert.deepEqual(items.map(item => item.kind), ['actions', 'subtask', 'sys']);

    const rows = (items[0] as ActionsItem).items;

    assert.deepEqual(
      rows.map(row => [row.label.tool ?? row.label.text, row.state, row.endedAt?.getTime() ?? null, row.endNote]),
      [
        ['Shell', 'done', t0.getTime() + 1000, 'exit 0'],
        ['Shell', 'off', end.getTime(), null],
        ['get_event', 'off', end.getTime(), null],
      ],
    );
    assert.equal((items[1] as SubtaskItem).state, 'off');

    const cancelled = run('thread.cancelled', { requestedBy: 'user', reason: 'enough' });

    assert.deepEqual((cancelled[0] as ActionsItem).items.map(row => row.state), ['done', 'off', 'off']);
    assert.equal((cancelled[1] as SubtaskItem).state, 'off');
  });

  it('a row starting after the thread’s own terminal is closed where it starts, a task announced again stays off, a real end that follows still brings its outcome', () => {
    resetSeq(10n);

    const t0 = new Date('2026-10-10T14:22:00Z');
    const end = new Date(t0.getTime() + 5000);
    const later = (ms: number) => new Date(end.getTime() + ms);
    const items = projectFeed(
      [
        own('session.tool.started', { toolUseId: 'u1', name: 'Shell', input: { command: 'ls' } }, { createdAt: t0 }),
        own('session.task.started', { taskId: 'k1', description: 'search', backgrounded: true }, { createdAt: new Date(t0.getTime() + 1000) }),
        // A child's terminal is not this thread's: it closes nothing.
        event({ type: 'thread.started', threadId: 'c9', targetThreadId: 't1', agentName: 'browser', payload: { agent: 'browser', title: 'look' }, createdAt: new Date(t0.getTime() + 2000) }),
        event({ type: 'thread.completed', threadId: 'c9', targetThreadId: 't1', agentName: 'browser', payload: { title: 'looked', summary: { text: 'ok' } }, createdAt: new Date(t0.getTime() + 3000) }),
        own('session.tool.started', { toolUseId: 'u2', name: 'Shell', input: { command: 'pwd' } }, { createdAt: new Date(t0.getTime() + 4000) }),
        event({ type: 'thread.failed', threadId: 't1', targetThreadId: 'main', payload: { error: 'boom' }, createdAt: end }),
        // The journal's tail after the terminal: a start that gets no end …
        own('session.tool.started', { toolUseId: 'u3', name: 'Shell', input: { command: 'cat x' } }, { createdAt: later(1000) }),
        // … a bridge call whose clock reads before the terminal …
        own('tool.call.started', { callId: 'c1', functionName: 'get_event', input: { seq: 1 } }, { createdAt: new Date(end.getTime() - 500) }),
        // … the backgrounded task announced again, a start whose real end follows, a task of the tail alone.
        own('session.task.started', { taskId: 'k1', description: 'search', backgrounded: true }, { createdAt: later(2000) }),
        own('session.tool.started', { toolUseId: 'u4', name: 'Shell', input: { command: 'echo' } }, { createdAt: later(3000) }),
        own('session.task.started', { taskId: 'k2', description: 'index', backgrounded: true }, { createdAt: later(3500) }),
        own('session.tool.completed', { toolUseId: 'u4', name: 'Shell', result: 'done', isError: false, exitCode: 0 }, { createdAt: later(4000) }),
        own('session.tool.completed', { toolUseId: 'u1', name: 'Shell', result: '', isError: true }, { createdAt: later(5000) }),
        own('session.task.completed', { taskId: 'k2', status: 'completed', summary: 'indexed' }, { createdAt: later(6000) }),
      ],
      ctx,
    );

    assert.deepEqual(items.map(item => item.kind), ['actions', 'subtask', 'child', 'actions', 'error', 'actions', 'subtask']);

    const row = (item: ActionsItem) => item.items.map(r => [r.label.tool ?? r.label.text, r.state, r.endedAt?.getTime() ?? null, r.endNote]);

    // The late real end replaces the terminal's close with its outcome.
    assert.deepEqual(row(items[0] as ActionsItem), [['Shell', 'err', later(5000).getTime(), 'error']]);
    assert.equal((items[1] as SubtaskItem).state, 'off');
    assert.equal((items[2] as ChildItem).state, 'done');
    // Closed by the own terminal, not by the child's.
    assert.deepEqual(row(items[3] as ActionsItem), [['Shell', 'off', end.getTime(), null]]);
    assert.deepEqual(row(items[5] as ActionsItem), [
      ['Shell', 'off', later(1000).getTime(), null],
      ['get_event', 'off', end.getTime(), null],
      ['Shell', 'done', later(4000).getTime(), 'exit 0'],
    ]);
    assert.equal((items[6] as SubtaskItem).state, 'done');
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

describe('projectFeed — the commands this thread gave its children', () => {
  it('names the child in the lines of a finish, cancel, stop or pause sent down; the same commands addressed to this thread speak of "the thread"', () => {
    resetSeq(1n);

    const items = projectFeed(
      [
        event({ type: 'thread.started', threadId: 'c9', targetThreadId: 't1', agentName: 'browser', payload: { agent: 'browser', title: 'Check the page' } }),
        own('thread.finish', { reason: 'finished_by_parent' }, { targetThreadId: 'c9' }),
        own('thread.cancel', { reason: 'enough' }, { targetThreadId: 'c9' }),
        own('thread.interrupt', { reason: 'stuck' }, { targetThreadId: 'c9' }),
        own('thread.pause', {}, { targetThreadId: 'c9' }),
        // A child neither the loaded range nor the store knows.
        own('thread.finish', { reason: 'finished_by_parent' }, { targetThreadId: 'c7' }),
        // The same command addressed to this thread, from the parent.
        event({ type: 'thread.finish', threadId: 'main', targetThreadId: 't1', agentName: 'coordinator', payload: { reason: 'finished_by_coordinator' } }),
        event({ type: 'thread.cancel', threadId: 'main', targetThreadId: 't1', agentName: 'coordinator', payload: { reason: 'enough' } }),
      ],
      ctx,
    );

    assert.deepEqual(
      items.map(item => (item.kind === 'sys' ? item.text : item.kind)),
      [
        'child',
        'engineer asked browser to finish its thread — it wraps up and ends with its report',
        'engineer asked to cancel browser’s thread — enough',
        'engineer stopped browser’s turn',
        'engineer paused browser’s thread',
        'engineer asked the child to finish its thread — it wraps up and ends with its report',
        'coordinator asked the agent to finish the thread — it wraps up and ends with its report',
        'coordinator asked to cancel the thread — enough',
      ],
    );
  });
});

describe('projectFeed — the operator in the system lines', () => {
  it('names the operator when Settings has a name, says "You" otherwise; the messages keep the "you" party', () => {
    const events = [
      event({ type: 'user.message', threadId: 't1', actor: 'user', payload: { text: 'hi' } }),
      event({ type: 'thread.cancel', threadId: 'main', targetThreadId: 't1', actor: 'user', payload: { reason: 'enough' } }),
      event({ type: 'thread.interrupt', threadId: 'main', targetThreadId: 't1', actor: 'user', payload: { reason: 'interrupted_by_user', source: 'web' } }),
      event({ type: 'thread.cancelled', threadId: 't1', payload: { reason: 'enough', requestedBy: 'user' } }),
    ];
    const text = (items: ReturnType<typeof projectFeed>) => items.map(item => (item.kind === 'sys' ? item.text : item.kind === 'message' ? `${item.from} → ${item.to}` : item.kind));
    const stopped = 'stopped the turn — the agent halted and is awaiting a message';

    resetSeq(1n);
    assert.deepEqual(text(projectFeed(events, ctx)), ['you → engineer', 'You asked to cancel the thread — enough', `You ${stopped}`, 'Thread cancelled by you — enough']);
    resetSeq(1n);
    assert.deepEqual(text(projectFeed(events, { ...ctx, you: 'Vladimir' })), ['you → engineer', 'Vladimir asked to cancel the thread — enough', `Vladimir ${stopped}`, 'Thread cancelled by Vladimir — enough']);
  });
});
