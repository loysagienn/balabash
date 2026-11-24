// The user's browser of an agent's run (user-browser.ts) over a link a test
// plays: which browser a run takes, when a session is opened, and what the
// browser tools say once a session ended by somebody else's hand.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext } from 'playwright';
import { BrowserAccessError, BrowserRequestError } from '../../src/browser-link/index.ts';
import type { BrowserSession, ControlRefusal, SessionEnd, WorkspaceBrowser } from '../../src/browser-link/index.ts';
import type { JsonObject, SessionEnvironmentTool } from '../../src/core/contract.ts';
import { chooseBrowser, createUserBrowser } from './user-browser.ts';
import type { UserBrowserLink } from './user-browser.ts';

const browser = (id: string, name: string, ownerName: string, connected: boolean): WorkspaceBrowser => ({
  id,
  name,
  ownerName,
  connected,
  lastSeenAt: new Date('2026-11-24T10:00:00Z'),
});

const WORK = browser('b-work', 'Work laptop', 'Vera Sokolova', true);
const HOME = browser('b-home', 'Home', 'Vera Sokolova', false);
const OTHER = browser('b-other', 'Home', 'Ilya Markov', true);

const chosen = (candidates: WorkspaceBrowser[], wanted: Parameters<typeof chooseBrowser>[1] = null) => {
  const choice = chooseBrowser(candidates, wanted);

  return 'browser' in choice ? choice.browser.id : choice.refusal;
};

describe('the browser a run takes', () => {
  test('unnamed, is the only one connected', () => {
    assert.equal(chosen([WORK, HOME]), 'b-work');
    assert.match(chosen([]), /No browser is linked to this workspace/);
  });

  test('unnamed, is nobody’s guess: none connected and several connected are refusals that list the candidates', () => {
    const none = chosen([HOME, { ...WORK, connected: false }]);

    assert.match(none, /None of the browsers linked to this workspace is connected now/);
    assert.match(none, /"Home" of Vera Sokolova — not connected, last seen 2026-11-24T10:00:00.000Z \(id b-home\)/);

    const several = chosen([WORK, HOME, OTHER]);

    assert.match(several, /Several linked browsers are connected/);
    assert.match(several, /"Work laptop" of Vera Sokolova — connected \(id b-work\)/);
    assert.match(several, /"Home" of Ilya Markov — connected \(id b-other\)/);
    assert.doesNotMatch(several, /b-home/, 'a browser that is not connected is not a candidate to choose from');
  });

  test('named, is found by its id, its name, its owner, or the name and the owner together', () => {
    const all = [WORK, HOME, OTHER];

    assert.equal(chosen(all, { browser: 'b-home' }), 'b-home');
    assert.equal(chosen(all, { browser: 'work LAPTOP ' }), 'b-work');
    assert.equal(chosen(all, { owner: 'ilya' }), 'b-other');
    assert.equal(chosen(all, { browser: 'Home', owner: 'Vera' }), 'b-home', 'a named browser is taken connected or not: opening it says it is offline');
  });

  test('named ambiguously or wrongly, is a refusal with the list', () => {
    const all = [WORK, HOME, OTHER];
    const twoHomes = chosen(all, { browser: 'Home' });

    assert.match(twoHomes, /More than one linked browser is "Home"/);
    assert.match(twoHomes, /b-home/);
    assert.match(twoHomes, /b-other/);
    assert.doesNotMatch(twoHomes, /b-work/);
    assert.match(chosen(all, { owner: 'Vera' }), /More than one linked browser is a browser of Vera/);
    assert.match(chosen(all, { browser: 'Office' }), /No browser linked to this workspace is "Office"[\s\S]*b-work/);
  });
});

// A link whose sessions the test ends by hand.
function fakeLink(browsers: WorkspaceBrowser[]) {
  const opened: { browserId: string; end(how: SessionEnd): void; notice(): void; claims: number[]; closed: boolean }[] = [];
  // How the user answers a request for a tab: nothing — they agree.
  const answers: { claim: null | ControlRefusal; tabs: null | ControlRefusal } = { claim: null, tabs: null };
  const link: UserBrowserLink = {
    browsers: async () => browsers,
    tabs: async () => {
      if (answers.tabs) {
        throw new BrowserRequestError('refused by the extension', answers.tabs);
      }

      return [{ id: 7, windowId: 1, groupId: -1, title: 'Inbox', url: 'https://mail.test/', active: true, owned: false, debuggable: true }];
    },
    open: async browserId => {
      if (!browsers.find(candidate => candidate.id === browserId)?.connected) {
        throw new BrowserAccessError('offline', 'This browser is not connected now');
      }

      let end!: (how: SessionEnd) => void;
      const ended = new Promise<{ end: SessionEnd; detail: string }>(resolve => {
        end = how => resolve({ end: how, detail: '' });
      });
      let notify: () => void = () => {};
      const entry = { browserId, end, notice: () => notify(), claims: [] as number[], closed: false };
      const session: BrowserSession = {
        browserId,
        endpoint: `ws://test/${opened.length}`,
        claimTab: async tabId => {
          if (answers.claim) {
            throw new BrowserRequestError('refused by the extension', answers.claim);
          }

          entry.claims.push(tabId);
        },
        onNotice: listener => {
          notify = () => listener({ sessionId: 1, kind: 'tab_blocked', tabId: 9 });
        },
        ended,
        close: async () => {
          entry.closed = true;
          end('closed');
        },
      };

      opened.push(entry);

      return session;
    },
    attach: async endpoint => ({ context: { endpoint } as unknown as BrowserContext, detach: async () => {} }),
  };

  return { link, opened, answers };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

function run(browsers: WorkspaceBrowser[]) {
  const { link, opened, answers } = fakeLink(browsers);
  const userBrowser = createUserBrowser({ workspaceId: 'w', clientName: 'test', label: async () => 'Label', link });
  const tools = new Map(userBrowser.tools().map(tool => [tool.name, tool]));
  const call = (name: string, args: JsonObject = {}) => tools.get(name)!.handler(args);
  // A tool of the Playwright kit: it needs the context, like every one of them.
  const kitTool = userBrowser.guard({
    name: 'browser_snapshot',
    description: '',
    inputSchema: {},
    handler: async () => ((await userBrowser.context()) as unknown as { endpoint: string }).endpoint,
  } satisfies SessionEnvironmentTool);

  return { userBrowser, opened, answers, call, snapshot: () => kitTool.handler({}) };
}

describe('a session', () => {
  test('is opened by the first browser call and not before; the tabs of the user are read without one', async () => {
    const { opened, call, snapshot } = run([WORK, HOME]);
    const listed = (await call('user_browsers_list')) as { browsers: { id: string; session: boolean }[] };

    assert.deepEqual(listed.browsers.map(entry => [entry.id, entry.session]), [['b-work', false], ['b-home', false]]);

    const tabs = (await call('user_browser_tabs')) as { browser: { id: string }; tabs: { title: string; session: boolean }[] };

    assert.equal(tabs.browser.id, 'b-work');
    assert.deepEqual(tabs.tabs.map(tab => [tab.title, tab.session]), [['Inbox', false]]);
    assert.equal(opened.length, 0);

    assert.equal(await snapshot(), 'ws://test/0');
    assert.equal(await snapshot(), 'ws://test/0', 'one session for the run');
    assert.deepEqual(opened.map(entry => entry.browserId), ['b-work']);
    assert.match(String(await call('user_browser_connect')), /already open in the browser "Work laptop" of Vera Sokolova/);
  });

  test('is not opened in a browser nobody chose, nor in one that is not connected', async () => {
    const several = run([WORK, OTHER]);

    await assert.rejects(several.snapshot(), /Several linked browsers are connected/);
    assert.equal(several.opened.length, 0);
    assert.match(String(await several.call('user_browser_connect', { owner: 'Ilya' })), /A session is open in the browser "Home" of Ilya Markov/);
    assert.equal(await several.snapshot(), 'ws://test/0');

    const offline = run([WORK, HOME]);

    await assert.rejects(offline.call('user_browser_connect', { browser: 'Home' }), /"Home" of Vera Sokolova is not connected now/);
    assert.equal(offline.opened.length, 0);
  });

  test('moves to another browser on user_browser_connect, closing the one it had', async () => {
    const { opened, call, snapshot } = run([WORK, OTHER]);

    await call('user_browser_connect', { browser: 'b-work' });
    await call('user_browser_connect', { browser: 'b-other' });
    assert.deepEqual(opened.map(entry => [entry.browserId, entry.closed]), [['b-work', true], ['b-other', false]]);
    assert.equal(await snapshot(), 'ws://test/1');
  });

  for (const [end, text] of [
    ['stopped', /The user stopped the session in their browser "Work laptop" of Vera Sokolova[\s\S]*Do not open a new session on your own/],
    ['revoked', /Access to the browser "Work laptop" of Vera Sokolova was withdrawn/],
    ['lost', /The link to the browser "Work laptop" of Vera Sokolova was lost/],
  ] as const) {
    test(`that ended as ${end} answers the browser tools with the reason until the agent connects again`, async () => {
      const { opened, call, snapshot } = run([WORK]);

      await snapshot();
      opened[0].end(end);
      await settle();
      await assert.rejects(snapshot(), text);
      await assert.rejects(snapshot(), text);
      assert.equal(opened.length, 1, 'no session is opened behind the agent’s back');

      await call('user_browser_connect');
      assert.equal(await snapshot(), 'ws://test/1');
    });
  }

  test('that ends under a call turns the failure of the call into the reason', async () => {
    const { link, opened } = fakeLink([WORK]);
    const userBrowser = createUserBrowser({ workspaceId: 'w', clientName: 'test', label: async () => '', link });
    const failing = userBrowser.guard({
      name: 'browser_click',
      description: '',
      inputSchema: {},
      handler: async () => {
        await userBrowser.context();
        // The link goes away, and the call fails with whatever Playwright says first.
        setTimeout(() => opened[0].end('stopped'), 20);

        throw new Error('Target page, context or browser has been closed');
      },
    });

    await assert.rejects(failing.handler({}), /The user stopped the session/);
  });

  test('is closed with the run', async () => {
    const { userBrowser, opened, snapshot } = run([WORK]);

    await snapshot();
    await userBrowser.dispose();
    assert.equal(opened[0].closed, true);
  });
});

describe('the boundaries the user keeps in the extension', () => {
  test('a tab of the user joins the session with their consent; a refusal is words the operator can act on', async () => {
    const { opened, answers, call } = run([WORK]);

    // Asking for a tab opens the session it is asked for.
    assert.match(String(await call('user_browser_take_tab', { tabId: 7 })), /The user handed the tab over/);
    assert.deepEqual(opened[0].claims, [7]);

    for (const [code, text] of [
      ['declined', /The user declined to hand this tab over\. Do not ask for it again/],
      ['no_answer', /did not answer the request within a minute/],
      ['blocked_site', /a site of the user's list of blocked sites/],
      ['not_debuggable', /Chrome lets nobody work in this tab/],
      ['owned', /belongs to the session of another agent/],
    ] as const) {
      answers.claim = code;
      await assert.rejects(call('user_browser_take_tab', { tabId: 8 }), text);
    }

    assert.deepEqual(opened[0].claims, [7]);
    await assert.rejects(call('user_browser_take_tab', {}), /needs the numeric `tabId`/);
  });

  test('the list of tabs the user switched off is said so', async () => {
    const { answers, call } = run([WORK]);

    answers.tabs = 'tabs_hidden';
    await assert.rejects(call('user_browser_tabs'), /The user switched the list of their tabs off/);
  });

  test('a tab taken from the session because it went to a blocked site is told once, by the next browser call', async () => {
    const { opened, snapshot } = run([WORK]);

    await snapshot();
    opened[0].notice();
    await assert.rejects(snapshot(), /went to a site of the user's list of blocked sites and was taken from the session/);
    assert.equal(await snapshot(), 'ws://test/0', 'the session goes on');
  });
});
