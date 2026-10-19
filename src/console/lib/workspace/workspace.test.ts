// The tab's workspace (lib/workspace) over fake storages: where a page
// starts (the link's ?ws=, the tab's, the browser's last), what a switch
// leaves for the next page, the colors of the marks, where signing out
// leads; the switcher's list and the outcome of one more sign-in
// (features/workspaces/workspaces.logic.ts).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeResponse, WorkspacesResponse } from '../../../api/contract.ts';
import { addOutcome, workspaceIds, workspaceItems } from '../../features/workspaces/workspaces.logic.ts';
import { assignColors, bootWorkspace, confirmWorkspace, currentWorkspace, nextAfterSignOut, prepareSwitch, readColors, takeFlash, withWorkspace } from './index.ts';

function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));

  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const refusing = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

describe('the tab’s workspace', () => {
  it('starts from the link’s ?ws= (taken out of the address and kept for the tab), else the tab’s, else the browser’s last', () => {
    const tab = memory({ 'balabash.workspace': 'tab-ws' });
    const browser = memory({ 'balabash.lastWorkspace': 'last-ws' });

    assert.deepEqual(bootWorkspace('https://c.test/secrets/r1?ws=link-ws#f', { tab, browser }), { workspaceId: 'link-ws', cleaned: '/secrets/r1#f' });
    assert.equal(tab.items.get('balabash.workspace'), 'link-ws');
    assert.equal(currentWorkspace(), 'link-ws');

    assert.deepEqual(bootWorkspace('https://c.test/threads?status=active&ws=x', { tab: memory(), browser }), { workspaceId: 'x', cleaned: '/threads?status=active' });
    assert.deepEqual(bootWorkspace('https://c.test/threads', { tab: memory({ 'balabash.workspace': 'tab-ws' }), browser }), { workspaceId: 'tab-ws', cleaned: null });
    assert.deepEqual(bootWorkspace('https://c.test/', { tab: memory(), browser }), { workspaceId: 'last-ws', cleaned: null });
    assert.deepEqual(bootWorkspace('https://c.test/', { tab: memory(), browser: memory() }), { workspaceId: null, cleaned: null });
    // Storage that refuses is storage that remembers nothing.
    assert.deepEqual(bootWorkspace('https://c.test/', { tab: refusing, browser: refusing }), { workspaceId: null, cleaned: null });
  });

  it('the confirmed workspace is the tab’s, and the browser’s last only while the tab is in front', () => {
    const tab = memory();
    const browser = memory();

    confirmWorkspace('a', { tab, browser, visible: false });
    assert.equal(tab.items.get('balabash.workspace'), 'a');
    assert.equal(browser.items.get('balabash.lastWorkspace'), undefined);
    confirmWorkspace('b', { tab, browser, visible: true });
    assert.equal(browser.items.get('balabash.lastWorkspace'), 'b');
    assert.equal(currentWorkspace(), 'b');
  });

  it('names the workspace on a URL the browser loads by itself', () => {
    assert.equal(withWorkspace('/files/a%20b.md', 'w1'), '/files/a%20b.md?ws=w1');
    assert.equal(withWorkspace('/files/a.md?download=1', 'w1'), '/files/a.md?download=1&ws=w1');
    assert.equal(withWorkspace('/api/events/stream?after=5#x', 'w 1'), '/api/events/stream?after=5&ws=w%201#x');
    assert.equal(withWorkspace('/files/a.md', null), '/files/a.md');
  });

  it('a switch leaves the next page its workspace and what to say; the flash is taken once', () => {
    const tab = memory();
    const browser = memory();

    prepareSwitch('w2', { kind: 'signed-in', back: { workspaceId: 'w1', name: 'Personal' } }, { tab, browser });
    assert.equal(tab.items.get('balabash.workspace'), 'w2');
    assert.equal(browser.items.get('balabash.lastWorkspace'), 'w2');
    assert.deepEqual(takeFlash(tab), { kind: 'signed-in', back: { workspaceId: 'w1', name: 'Personal' } });
    assert.equal(takeFlash(tab), null);

    tab.items.set('balabash.workspaceFlash', '{broken');
    assert.equal(takeFlash(tab), null);
  });

  it('after signing out: the last workspace the user was in, if still signed in, else the first', () => {
    assert.equal(nextAfterSignOut(['a', 'b'], 'b'), 'b');
    assert.equal(nextAfterSignOut(['a', 'b'], 'gone'), 'a');
    assert.equal(nextAfterSignOut(['a'], null), 'a');
    assert.equal(nextAfterSignOut([], 'a'), null);
  });

  it('colors: a stored one stays, a new workspace takes the first color nobody holds, nine cycle', () => {
    assert.deepEqual(assignColors(['a', 'b'], { a: 1 }), { colors: { a: 1, b: 2 }, assigned: true });
    assert.deepEqual(assignColors(['a', 'b'], { a: 2, b: 1 }), { colors: { a: 2, b: 1 }, assigned: false });
    assert.deepEqual(assignColors(['a', 'b', 'c'], { a: 1, c: 2 }).colors, { a: 1, b: 3, c: 2 });

    const nine = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

    assert.equal(assignColors(nine, {}).colors['9'], 1);
    // Garbage in storage is no color.
    assert.deepEqual(readColors(memory({ 'balabash.workspaceColors': '{"a":3,"b":12,"c":"x"}' })), { a: 3 });
    assert.deepEqual(readColors(memory({ 'balabash.workspaceColors': 'nope' })), {});
  });
});

describe('the switcher’s list', () => {
  const me: MeResponse = { workspaceId: 'p', workspaceName: 'Personal (renamed)', operatorName: 'Vladimir', mainThreadId: 't' };
  const list: WorkspacesResponse = {
    current: 'p',
    workspaces: [
      { workspaceId: 'p', workspaceName: 'Personal', operatorName: 'Vladimir', signedInAt: new Date(1), loginSource: 'console' },
      { workspaceId: 'f', workspaceName: null, operatorName: null, signedInAt: new Date(2), loginSource: 'telegram' },
    ],
  };

  it('in the order signed in, the tab’s own speaking with `me`, an unnamed one as “Workspace”', () => {
    const items = workspaceItems(me, list, { p: 6, f: 3 });

    assert.deepEqual(
      items.map(item => [item.workspaceId, item.name, item.operator, item.color, item.current]),
      [
        ['p', 'Personal (renamed)', 'Vladimir', 6, true],
        ['f', 'Workspace', null, 3, false],
      ],
    );
  });

  it('without the list (loading, failed, an older server) — the tab’s own alone', () => {
    assert.deepEqual(workspaceIds(me, undefined), ['p']);
    assert.deepEqual(
      workspaceItems(me, undefined, { p: 2 }).map(item => [item.workspaceId, item.name, item.current, item.signedInAt]),
      [['p', 'Personal (renamed)', true, null]],
    );
  });

  it('a code’s workspace: the tab’s own — nothing; a known one — a switch; a new one — added', () => {
    assert.deepEqual(addOutcome('p', 'p', ['p', 'f']), { kind: 'same' });
    assert.deepEqual(addOutcome('f', 'p', ['p', 'f']), { kind: 'switch', workspaceId: 'f' });
    assert.deepEqual(addOutcome('n', 'p', ['p', 'f']), { kind: 'added', workspaceId: 'n' });
  });
});
