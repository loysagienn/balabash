import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { actionDuration, bridgeAction, nativeAction, resultText, shortPath } from './actions.ts';
import { actionTimer, cutText, fence } from './details.ts';

describe('nativeAction', () => {
  it('names commands, file tools, searches, web tools, agents and MCP tools with their arguments', () => {
    assert.deepEqual(nativeAction('Bash', { command: 'npm run build\necho done' }).label, { icon: 'square-terminal', tool: 'Bash', arg: 'npm run build' });
    assert.deepEqual(nativeAction('Shell', { command: '/bin/bash -lc "ls"' }, 'a\nb').detail, { kind: 'terminal', command: '/bin/bash -lc "ls"', output: 'a\nb' });

    const write = nativeAction('Write', { file_path: '/w/x/y/z/new.md', content: 'one\ntwo' });

    assert.deepEqual(write.label, { icon: 'file-pen-line', tool: 'Write', arg: '…/y/z/new.md' });
    assert.equal(write.add, 2);
    assert.equal(write.del, undefined);
    assert.equal(write.detail?.kind === 'diff' ? write.detail.diff : '', '--- …/y/z/new.md\n+++ …/y/z/new.md\n+one\n+two');

    const change = nativeAction('FileChange', { changes: [{ kind: 'update', path: '/a/b.md' }, { kind: 'add', path: '/a/c.md' }] });

    assert.deepEqual(change.label, { icon: 'file-pen-line', tool: 'Edit', arg: 'a/b.md +1' });

    assert.deepEqual(nativeAction('Read', { file_path: '/p/q.ts' }).label, { icon: 'file-text', tool: 'Read', arg: 'p/q.ts' });
    assert.deepEqual(nativeAction('Grep', { pattern: 'slug', path: '/src/api' }).label, { icon: 'search', tool: 'Grep', arg: 'slug in src/api' });
    assert.deepEqual(nativeAction('WebFetch', { url: 'https://example.com/a' }).label, { icon: 'globe', tool: 'WebFetch', arg: 'example.com/a' });
    assert.deepEqual(nativeAction('Agent', { description: 'find refs', prompt: 'long' }).label, { icon: 'bot', tool: 'Agent', arg: 'find refs' });
    assert.deepEqual(nativeAction('mcp__claude_design__get_file', { path: 'x.html' }).label, { icon: 'plug', tool: 'get_file', arg: 'x.html' });
    assert.deepEqual(nativeAction('ToolSearch', { query: 'select:Foo', max_results: 1 }).label, { icon: 'wrench', tool: 'ToolSearch', arg: 'select:Foo' });
  });

  it('turns a result into text: strings as is, blocks joined, omitted binaries named', () => {
    assert.equal(resultText('plain'), 'plain');
    assert.equal(resultText([{ type: 'text', text: 'a' }, { type: 'image', omitted: true, mediaType: 'image/png' }]), 'a\n[image omitted · image/png]');
    assert.equal(resultText({ status: 'completed' }), '{\n  "status": "completed"\n}');
    assert.equal(resultText(undefined), '');
  });
});

describe('bridgeAction', () => {
  it('names a bridge function by its first string argument and a known icon', () => {
    assert.deepEqual(bridgeAction('spawn_agent', { agent: 'browser', title: 'Check' }).label, { icon: 'bot', tool: 'spawn_agent', arg: 'browser' });
    assert.deepEqual(bridgeAction('get_event', { seq: 17588 }).label, { icon: 'file-text', tool: 'get_event', arg: '17588' });
    assert.deepEqual(bridgeAction('gmail_search_emails', {}).label, { icon: 'inbox', tool: 'gmail_search_emails' });
  });
});

describe('durations, paths and cuts', () => {
  it('formats durations and the running timer', () => {
    assert.equal(actionDuration(120), '0.1s');
    assert.equal(actionDuration(4200), '4.2s');
    assert.equal(actionDuration(38_400), '38s');
    assert.equal(actionDuration(72_000), '1:12');
    assert.equal(actionDuration(3_725_000), '1:02:05');
    assert.equal(actionTimer(12_400), '0:12');
    assert.equal(actionTimer(61_000), '1:01');
  });

  it('shortens paths to their tail and cuts long text with the totals', () => {
    assert.equal(shortPath('/home/u/projects/x/src/a/b.ts'), '…/src/a/b.ts');
    assert.equal(shortPath('a/b.ts'), 'a/b.ts');
    assert.deepEqual(cutText('abcdef', 4), { text: 'abcd', cut: true, total: 6 });
    assert.deepEqual(cutText('abc', 4), { text: 'abc', cut: false, total: 3 });
    assert.equal(fence('diff', '+a'), '```diff\n+a\n```');
    assert.equal(fence('diff', 'x ``` y'), '````diff\nx ``` y\n````');
  });
});
