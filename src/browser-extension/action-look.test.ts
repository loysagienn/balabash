// The look of the toolbar button for each state of the link: the image, the
// badge, the words of the tooltip, and the mark of a session's tab.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { actionLook, lowerFirst } from './action-look.ts';
import type { LinkStatus, SessionView } from './link.ts';

const status = (over: Partial<LinkStatus>): LinkStatus => ({
  state: 'connected',
  browserId: 'b1',
  name: 'Chrome on Mac',
  detail: '',
  version: '0.7.0',
  serverVersion: '0.7.0',
  update: null,
  sessions: [],
  ...over,
});

const session = (over: Partial<SessionView>): SessionView => ({
  id: 1,
  label: 'Personal — Find flights',
  workspace: 'Personal',
  thread: 'Find flights to Lisbon for March 12–19 and compare fares',
  group: { title: 'Find flights to Lisb…', color: 'blue' },
  parked: false,
  tabIds: [10, 11],
  ...over,
});

describe('the toolbar button', () => {
  it('is muted and bare while the browser is not connected', () => {
    const look = actionLook(status({ state: 'unpaired', browserId: null, name: '' }));

    assert.deepEqual([look.image, look.badge.text], ['muted', '']);
    assert.match(look.title, /not connected\. Open Connections/);
  });

  it('carries the pause in its image', () => {
    const look = actionLook(status({ state: 'paused' }));

    assert.deepEqual([look.image, look.badge.text], ['paused', '']);
    assert.match(look.title, /paused/);
  });

  it('waits with "…" while the link is being dialed or is down, with the last reason', () => {
    assert.deepEqual([actionLook(status({ state: 'connecting' })).image, actionLook(status({ state: 'connecting' })).badge.text], ['muted', '…']);

    const offline = actionLook(status({ state: 'offline', detail: 'The server is not reachable' }));

    assert.deepEqual([offline.image, offline.badge.text], ['muted', '…']);
    assert.equal(offline.title, 'Balabash Agent — no link to the server, retrying. Last try: the server is not reachable.');
  });

  it('asks for an update with "!", whether the link is up or not', () => {
    for (const state of ['connected', 'offline'] as const) {
      const look = actionLook(status({ state, update: 'needed' }));

      assert.deepEqual([look.image, look.badge.text, look.badge.color], ['muted', '!', '#f9ab00']);
    }

    // A newer version that is merely out changes nothing on the button.
    assert.deepEqual([actionLook(status({ update: 'available' })).image, actionLook(status({ update: 'available' })).badge.text], ['color', '']);
  });

  it('is in color and names the browser when connected without sessions', () => {
    const look = actionLook(status({}));

    assert.deepEqual([look.image, look.badge.text], ['color', '']);
    assert.equal(look.title, 'Balabash Agent — connected as “Chrome on Mac”.');
  });

  it('counts the sessions: green while one works, grey when all are idle', () => {
    const mixed = actionLook(status({ sessions: [session({}), session({ id: 2, parked: true, tabIds: [20] })] }));

    assert.deepEqual([mixed.badge.text, mixed.badge.color], ['2', '#188038']);
    assert.equal(mixed.title, 'Balabash Agent — 1 working, 1 idle.');

    const idle = actionLook(status({ sessions: [session({ parked: true })] }));

    assert.deepEqual([idle.badge.text, idle.badge.color], ['1', '#5f6368']);
    assert.equal(idle.title, 'Balabash Agent — 1 idle session. It comes back to its tabs on its own.');
  });

  it('marks every tab of a session with "B" in the color of its group', () => {
    const look = actionLook(status({ sessions: [session({}), session({ id: 2, workspace: '', thread: 'Renew', parked: true, tabIds: [20], group: { title: 'Renew', color: 'purple' } })] }));

    assert.deepEqual([...look.tabs.keys()], [10, 11, 20]);
    assert.deepEqual(look.tabs.get(10), {
      badge: { text: 'B', color: '#8ab4f8', ink: '#202124' },
      title: 'This tab is with “Find flights to Lisbon for March…” (Personal) — working.',
    });
    assert.deepEqual(look.tabs.get(20), { badge: { text: 'B', color: '#d7aefb', ink: '#202124' }, title: 'This tab is with “Renew” — idle.' });
  });
});

describe('a reason after "Last try:"', () => {
  it('starts low and ends without a period', () => {
    assert.equal(lowerFirst('The server closed the link.'), 'the server closed the link');
  });
});
