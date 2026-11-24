// A user's own browser inside an agent's run: which of the browsers linked
// to the workspace the run works in, the session it holds there and the
// tools that are this browser's own (src/browser-link is the link itself).
//
// The session is lazy: nothing is opened in the user's Chrome until the
// agent first reaches for the browser — a tool of the Playwright kit asking
// for its context, or `user_browser_connect`. Opening is a session of the
// link behind a CDP endpoint and a Playwright client connected to it; the
// context the kit works in is the browser's default one.
//
// Which browser: the one the agent named with `user_browser_connect`;
// unnamed — the only one connected now. Anything else is a refusal that
// lists the candidates: the agent picks by its operator's words or hands
// the list back, it does not guess.
//
// A session that ended by somebody else's hand — the user stopped it, the
// owner withdrew the browser, the link was lost — is not opened again
// behind the agent's back: the browser tools answer with the reason until
// the agent calls `user_browser_connect`. The reason is words the operator
// can act on.
//
// The user's boundaries live in the extension, and what it refuses comes
// here as a code this module turns into words: a tab the user did not hand
// over, a site of the user's blocked list, the list of tabs switched off.
// A tab the extension took from the session — it went to a blocked site —
// is told once, by the next browser call.

import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import type { JsonObject, SessionEnvironmentTool } from '../../src/core/contract.ts';
import { BrowserAccessError, BrowserRequestError, openBrowserSession, workspaceBrowserTabs, workspaceBrowsers } from '../../src/browser-link/index.ts';
import type { BrowserSession, BrowserTab, ControlRefusal, SessionEnd, WorkspaceBrowser } from '../../src/browser-link/index.ts';

const CONNECT_TIMEOUT_MS = 30_000;
// How long a failed browser call waits to learn that the session is over:
// the call fails first, the end of the link is heard a moment later.
const END_SETTLE_MS = 300;

// Which browser the agent named: by its name or id, by its owner, or both.
export type Wanted = { browser?: string; owner?: string };

// The link as this module uses it; a test plays it.
export type UserBrowserLink = {
  browsers(): Promise<WorkspaceBrowser[]>;
  tabs(browserId: string): Promise<BrowserTab[]>;
  open(browserId: string): Promise<BrowserSession>;
  // The Playwright client of a session: its context and what drops it.
  attach(endpoint: string): Promise<{ context: BrowserContext; detach(): Promise<void> }>;
};

export type UserBrowser = {
  // The context of the session, opening one when none is open.
  context(): Promise<BrowserContext>;
  tools(): SessionEnvironmentTool[];
  // Wraps a tool of the Playwright kit: its failure after the session ended
  // is the reason of the end.
  guard(tool: SessionEnvironmentTool): SessionEnvironmentTool;
  dispose(): Promise<void>;
};

// The session a run holds: where, and its Playwright client.
type Held = { browser: WorkspaceBrowser; session: BrowserSession; context: BrowserContext; detach(): Promise<void> };

const same = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();

function describe(browser: WorkspaceBrowser): string {
  return `"${browser.name}" of ${browser.ownerName ?? 'an unnamed user'}`;
}

function listing(candidates: WorkspaceBrowser[]): string {
  return candidates
    .map(browser => {
      const seen = browser.connected ? 'connected' : `not connected${browser.lastSeenAt ? `, last seen ${browser.lastSeenAt.toISOString()}` : ''}`;

      return `- ${describe(browser)} — ${seen} (id ${browser.id})`;
    })
    .join('\n');
}

const NO_BROWSERS =
  'No browser is linked to this workspace. A user links their Chrome on the Connections screen of the console. Report this to the operator.';

// The browser to work in, or why there is none to take: the words go to the
// agent as the refusal of its call.
export function chooseBrowser(candidates: WorkspaceBrowser[], wanted: Wanted | null): { browser: WorkspaceBrowser } | { refusal: string } {
  if (candidates.length === 0) {
    return { refusal: NO_BROWSERS };
  }

  const named = wanted?.browser?.trim();
  const owner = wanted?.owner?.trim().toLowerCase();

  if (named || owner) {
    const byId = named ? candidates.find(browser => browser.id === named) : undefined;
    const matches = byId
      ? [byId]
      : candidates.filter(
          browser => (!named || same(browser.name, named)) && (!owner || (browser.ownerName ?? '').toLowerCase().includes(owner)),
        );
    const asked = [named ? `"${named}"` : 'a browser', owner ? `of ${wanted!.owner!.trim()}` : ''].filter(Boolean).join(' ');

    if (matches.length === 1) {
      return { browser: matches[0] };
    }

    return {
      refusal:
        matches.length === 0
          ? `No browser linked to this workspace is ${asked}. The linked browsers:\n${listing(candidates)}`
          : `More than one linked browser is ${asked} — name the one to use by its id:\n${listing(matches)}`,
    };
  }

  const connected = candidates.filter(browser => browser.connected);

  if (connected.length === 1) {
    return { browser: connected[0] };
  }

  return {
    refusal:
      connected.length === 0
        ? `None of the browsers linked to this workspace is connected now: the Chrome is closed, asleep or offline, or its extension is paused. Report this to the operator instead of waiting for it. The linked browsers:\n${listing(candidates)}`
        : `Several linked browsers are connected. Choose the one the operator's instruction names with user_browser_connect — if it names none, hand this list to the operator instead of guessing:\n${listing(connected)}`,
  };
}

// What the browser tools answer once a session ended by somebody else's hand.
export function sessionEndText(end: Exclude<SessionEnd, 'closed'>, browser: WorkspaceBrowser): string {
  switch (end) {
    case 'stopped':
      return (
        `The user stopped the session in their browser ${describe(browser)} — closed the debugging bar of Chrome or paused the extension. ` +
        'Do not open a new session on your own: report this to the operator and wait for the next instruction. The tabs of the session stay open in the browser.'
      );
    case 'revoked':
      return (
        `Access to the browser ${describe(browser)} was withdrawn: its owner disconnected it from Balabash or switched it off for this workspace. ` +
        'Report this to the operator. The tabs of the session stay open in the browser.'
      );
    case 'lost':
      return (
        `The link to the browser ${describe(browser)} was lost: the Chrome was closed, went to sleep or lost the network. ` +
        'The tabs of the session stay open there but belong to no session any more. Report this to the operator; user_browsers_list shows whether the ' +
        'browser is connected again, and user_browser_connect then opens a new session with a blank tab.'
      );
  }
}

// What the extension refused by the user's rules, in words for the agent.
const REFUSALS: Record<ControlRefusal, string> = {
  tabs_hidden:
    "The user switched the list of their tabs off in the settings of the extension: you work in the tabs of your own session and in the ones the user hands over.",
  declined:
    'The user declined to hand this tab over. Do not ask for it again unless the operator says so; report this to the operator.',
  no_answer:
    'The user did not answer the request within a minute, so the tab was not handed over. Report this to the operator: the user may be away from the browser.',
  blocked_site: "This tab shows a site of the user's list of blocked sites: it is closed to you. Report this to the operator.",
  not_debuggable: 'Chrome lets nobody work in this tab: it shows a page of the browser itself.',
  owned: 'This tab belongs to the session of another agent.',
};

export const TAB_TAKEN_TEXT =
  "A tab of your session went to a site of the user's list of blocked sites and was taken from the session: the page stays open in the user's " +
  'browser, but you cannot work in it or read it. Do not try to reach that site another way; tell the operator. The session goes on in its other ' +
  'tabs — browser_tabs lists them.';

function accessRefusal(error: unknown, browser: WorkspaceBrowser): Error {
  if (error instanceof BrowserRequestError && error.code && error.code in REFUSALS) {
    return new Error(REFUSALS[error.code as ControlRefusal]);
  }

  if (error instanceof BrowserAccessError) {
    return new Error(
      error.code === 'offline'
        ? `The browser ${describe(browser)} is not connected now: the Chrome is closed, asleep or offline, or its extension is paused. Report this to the operator instead of waiting for it.`
        : `The browser ${describe(browser)} is not enabled in this workspace any more. Report this to the operator.`,
    );
  }

  return new Error(`The browser ${describe(browser)} did not do it: ${error instanceof Error ? error.message : String(error)}`);
}

// The Playwright client of a session: connected to its CDP endpoint, working
// in the browser's default context. The browser is on another machine —
// Playwright is not told the two share a file system, so a file it uploads
// travels by content, not by path.
export async function attachToSession(endpoint: string): Promise<{ context: BrowserContext; detach(): Promise<void> }> {
  const remote = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: CONNECT_TIMEOUT_MS });
  const context = remote.contexts()[0];

  if (!context) {
    await remote.close().catch(() => {});

    throw new Error('The browser has no context to work in');
  }

  return { context, detach: () => remote.close() };
}

const liveLink = (workspaceId: string, session: { clientName: string; label(): Promise<string> }): UserBrowserLink => ({
  browsers: () => workspaceBrowsers(workspaceId),
  tabs: browserId => workspaceBrowserTabs(workspaceId, browserId),
  open: async browserId => openBrowserSession({ workspaceId, browserId, clientName: session.clientName, label: await session.label() }),
  attach: attachToSession,
});

const WANTED_SCHEMA = {
  browser: { type: 'string', description: 'The name of the browser, or its id from user_browsers_list.' },
  owner: { type: 'string', description: 'The display name of the owner of the browser, or a part of it.' },
};

function wantedOf(args: JsonObject): Wanted | null {
  const browser = typeof args.browser === 'string' && args.browser.trim() ? args.browser : undefined;
  const owner = typeof args.owner === 'string' && args.owner.trim() ? args.owner : undefined;

  return browser || owner ? { ...(browser ? { browser } : {}), ...(owner ? { owner } : {}) } : null;
}

export function createUserBrowser(options: {
  workspaceId: string;
  // Names the client to the extension.
  clientName: string;
  // What the user reads about the session in their browser.
  label(): Promise<string>;
  link?: UserBrowserLink;
}): UserBrowser {
  const link = options.link ?? liveLink(options.workspaceId, options);
  // The browser the agent named: the next session opens there.
  let chosen: WorkspaceBrowser | null = null;
  let current: Held | null = null;
  let opening: Promise<Held> | null = null;
  // Why the last session ended, when it was not this run that ended it.
  let ended: string | null = null;
  // The extension took a tab from the session, and the agent has not heard yet.
  let tabTaken = false;

  const pick = async (wanted: Wanted | null): Promise<WorkspaceBrowser> => {
    const candidates = await link.browsers();
    // The browser named before stays the choice while it is the workspace's.
    const remembered = wanted ? null : chosen && candidates.find(browser => browser.id === chosen!.id);
    const choice = remembered ? { browser: remembered } : chooseBrowser(candidates, wanted);

    if ('refusal' in choice) {
      throw new Error(choice.refusal);
    }

    return choice.browser;
  };

  const open = (browser: WorkspaceBrowser): Promise<Held> => {
    opening ??= (async (): Promise<Held> => {
      const session = await link.open(browser.id).catch(error => {
        throw accessRefusal(error, browser);
      });

      try {
        const attached = await link.attach(session.endpoint);
        const held: Held = { browser, session, ...attached };

        current = held;
        ended = null;
        tabTaken = false;
        session.onNotice(() => {
          if (current === held) {
            tabTaken = true;
          }
        });
        void session.ended.then(({ end }) => {
          if (current === held) {
            current = null;
            ended = end === 'closed' ? null : sessionEndText(end, browser);
          }

          void held.detach().catch(() => {});
        });

        return held;
      } catch (error) {
        await session.close().catch(() => {});

        throw accessRefusal(error, browser);
      }
    })().finally(() => {
      opening = null;
    });

    return opening;
  };

  const close = async () => {
    const held = current ?? (await opening?.catch(() => null));

    if (!held) {
      return;
    }

    // Ended by this run: no reason to keep.
    if (current === held) {
      current = null;
    }

    await held.detach().catch(() => {});
    await held.session.close().catch(() => {});
  };

  const connect = async (wanted: Wanted | null): Promise<string> => {
    const browser = await pick(wanted);

    chosen = browser;

    if (current?.browser.id === browser.id) {
      return `The session is already open in the browser ${describe(browser)}.`;
    }

    await close();
    ended = null;
    await open(browser);

    return (
      `A session is open in the browser ${describe(browser)}: one blank tab of its own in the "Balabash" tab group, in the background. ` +
      'The browser tools work in the tabs of this session.'
    );
  };

  return {
    async context() {
      if (current) {
        return current.context;
      }

      if (ended) {
        throw new Error(ended);
      }

      return (await (opening ?? open(await pick(null)))).context;
    },

    tools: () => [
      {
        name: 'user_browsers_list',
        description:
          'The browsers users linked to this workspace: the owner, the name, whether the browser is connected now and when it was last on the link. ' +
          '`session: true` marks the one your session is open in.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({
          browsers: (await link.browsers()).map(browser => ({
            id: browser.id,
            owner: browser.ownerName,
            name: browser.name,
            connected: browser.connected,
            lastSeenAt: browser.lastSeenAt?.toISOString() ?? null,
            session: current?.browser.id === browser.id,
          })),
        }),
      },
      {
        name: 'user_browser_connect',
        description:
          'Choose one of the linked browsers and open a session in it: a blank tab of your own in the "Balabash" tab group of that Chrome. ' +
          'Name the browser by `browser`, by `owner`, or by both; without arguments — the browser named before, or the only one connected now. ' +
          'A session open in another browser is closed first. This is also the only way to a new session after one has ended.',
        inputSchema: { type: 'object', properties: WANTED_SCHEMA },
        handler: async args => connect(wantedOf(args)),
      },
      {
        name: 'user_browser_tabs',
        description:
          'The tabs the user has open in the browser: `id`, `title`, `url`, `windowId`, `active` (the tab in front in its window), `session` (the tab ' +
          'belongs to a session — yours or another), `debuggable` (false for pages of Chrome itself, which no session can work in). Read from the ' +
          "extension without a session and without touching the pages. The browser is the one of your session; before a session — the one named with " +
          'user_browser_connect or the only one connected. browser_tabs, by contrast, lists the tabs of your own session.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          const browser = current?.browser ?? (await pick(null));
          const tabs = await link.tabs(browser.id).catch(error => {
            throw accessRefusal(error, browser);
          });

          return {
            browser: { id: browser.id, owner: browser.ownerName, name: browser.name },
            tabs: tabs.map(tab => ({
              id: tab.id,
              title: tab.title,
              url: tab.url,
              windowId: tab.windowId,
              active: tab.active,
              session: tab.owned,
              debuggable: tab.debuggable,
            })),
          };
        },
      },
      {
        name: 'user_browser_take_tab',
        description:
          "Ask the user for one of their own tabs, by its `id` from user_browser_tabs. The user is asked in a window of their browser — which session " +
          'asks and for which tab — and has a minute to answer; the call returns once they did (at once when the user chose in the extension not ' +
          'to be asked). With their consent the tab joins your session and browser_tabs lists it; the page stays as the user left it. A refusal ' +
          'comes back as an error that says what happened.',
        inputSchema: {
          type: 'object',
          properties: { tabId: { type: 'number', description: 'The `id` of the tab in user_browser_tabs.' } },
          required: ['tabId'],
        },
        handler: async args => {
          if (typeof args.tabId !== 'number') {
            throw new Error('user_browser_take_tab needs the numeric `tabId` of a tab from user_browser_tabs');
          }

          if (!current && ended) {
            throw new Error(ended);
          }

          const held = current ?? (await (opening ?? open(await pick(null))));

          await held.session.claimTab(args.tabId).catch(error => {
            throw accessRefusal(error, held.browser);
          });

          return 'The user handed the tab over: it is in your session now, and browser_tabs lists it.';
        },
      },
    ],

    guard: tool => ({
      ...tool,
      handler: async args => {
        if (!current && ended) {
          throw new Error(ended);
        }

        // Told once, before the agent goes on as if the tab were there.
        if (current && tabTaken) {
          tabTaken = false;

          throw new Error(TAB_TAKEN_TEXT);
        }

        try {
          return await tool.handler(args);
        } catch (error) {
          if (current) {
            // The end of the link, or of a tab, is heard a moment after the call it broke.
            await new Promise(resolve => setTimeout(resolve, END_SETTLE_MS));
          }

          if (!current && ended) {
            throw new Error(ended);
          }

          if (current && tabTaken) {
            tabTaken = false;

            throw new Error(TAB_TAKEN_TEXT);
          }

          throw error;
        }
      },
    }),

    dispose: close,
  };
}
