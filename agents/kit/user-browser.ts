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
// the list back, it does not guess. Nor does this module guess for it: an
// id and an owner that name different browsers are a refusal, and so is a
// browser named before that the workspace has no more — another browser is
// another person's.
//
// A session that ended by somebody else's hand — the user stopped it, the
// owner withdrew the browser, the link was lost — is not opened again
// behind the agent's back: the browser tools answer with the reason until
// the agent calls `user_browser_connect`. The reason is words the operator
// can act on.
//
// A session nobody has used for a while is parked (src/browser-link/hub.ts):
// the debugger leaves its tabs, and Chrome's debugging bar leaves the user's
// windows with it; the tabs stay in their group. The next browser call
// brings the session back. The kit's own state does not survive that — its
// Playwright client is a new one — so what the agent could notice is put
// back here: the tabs come back in the order the kit numbered them, and the
// tab the kit worked in is made its current tab again (the kit's own
// browser_tabs tells which one that is, and selects it). What cannot be put
// back — the user closed a tab or took it out of the group meanwhile, so
// the numbers of the tabs moved, or the tab the kit worked in is gone — is
// said to the agent instead of doing what it asked: the call that brought
// the session back is refused once, before it acts in a tab the agent did
// not mean. A parked session can end like an open one — the user stops it,
// the owner withdraws the browser, the link is lost — and the next browser
// call then answers with the reason.
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
import type {
  BrowserSession,
  BrowserTab,
  ControlRefusal,
  ParkedBrowserSession,
  SessionEnd,
  WorkspaceBrowser,
} from '../../src/browser-link/index.ts';
import type { SessionAbout } from '../../src/browser-link/protocol.ts';

const CONNECT_TIMEOUT_MS = 30_000;
// How long a session stands unused before it is parked. Longer than an
// agent thinks between two calls: every parking and return shows in the
// user's windows as the debugging bar going and coming.
const IDLE_PARK_MS = 60_000;
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

// The session a run parked: the tabs it had, in the kit's numbering, and
// the one the kit worked in (null — not known).
type Resting = { browser: WorkspaceBrowser; parked: ParkedBrowserSession; order: number[]; front: number | null };

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
    const ownedBy = (browser: WorkspaceBrowser) => !owner || (browser.ownerName ?? '').toLowerCase().includes(owner);
    const byId = named ? candidates.find(browser => browser.id === named) : undefined;
    // An id names one browser, and an owner named with it must be its owner.
    const matches = byId ? [byId].filter(ownedBy) : candidates.filter(browser => (!named || same(browser.name, named)) && ownedBy(browser));
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
        `The user stopped the session in their browser ${describe(browser)} — closed the debugging bar of Chrome, pressed Stop in the extension or paused it. ` +
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
  tab_changed:
    'The tab went to another site while the user was deciding, so it was not handed over: their answer was about the page it showed before. ' +
    'user_browser_tabs shows what the tab shows now; ask for it again if it is still the one you need.',
  blocked_site: "This tab shows a site of the user's list of blocked sites: it is closed to you. Report this to the operator.",
  not_debuggable: 'Nobody can work in this tab: it shows a page of the browser itself or of an extension.',
  owned: 'This tab belongs to the session of another agent.',
};

export const TAB_TAKEN_TEXT =
  "A tab of your session went to a site of the user's list of blocked sites and was taken from the session: the page stays open in the user's " +
  'browser, but you cannot work in it or read it. Do not try to reach that site another way; tell the operator. The session goes on in its other ' +
  'tabs — browser_tabs lists them.';

// What the agent hears once after a parked session came back without some
// of its tabs.
export function tabsGoneText(gone: number, frontGone: boolean): string {
  return (
    `While your session was parked, ${gone === 1 ? 'one of its tabs was' : `${gone} of its tabs were`} closed or taken out of its group by the user` +
    `${frontGone ? ' — the tab you were working in among them' : ''}. The session goes on in the tabs it has now: browser_tabs lists them.`
  );
}

// Said instead of doing what the agent asked, when the tabs of a session
// that came back are not the ones the agent knew.
export const NOT_DONE_TEXT =
  'Your call was not carried out: the numbers of the tabs have changed, and the current tab may not be the one you meant. ' +
  'Look at browser_tabs, select the tab you need, then repeat the call.';

// The number of the kit's current tab in the listing its browser_tabs
// prints ("- 1: (current) [title](url)"), and how many tabs the listing has.
export function currentTabOf(listing: string): { index: number; count: number } | null {
  // The answer of a kit tool is sections under `### ` headings; the listing is the result.
  const from = listing.indexOf('### Result\n');
  const body = from === -1 ? listing : listing.slice(from + '### Result\n'.length);
  const until = body.indexOf('\n### ');
  const result = until === -1 ? body : body.slice(0, until);
  const lines = result.split('\n').filter(line => /^- \d+:/.test(line));
  const index = lines.findIndex(line => /^- \d+: \(current\) /.test(line));

  return index === -1 ? null : { index, count: lines.length };
}

function accessRefusal(error: unknown, browser: WorkspaceBrowser): Error {
  if (error instanceof BrowserRequestError && error.code && error.code in REFUSALS) {
    return new Error(REFUSALS[error.code as ControlRefusal]);
  }

  if (error instanceof BrowserAccessError) {
    const said: Record<BrowserAccessError['code'], string> = {
      offline: `The browser ${describe(browser)} is not connected now: the Chrome is closed, asleep or offline, or its extension is paused. Report this to the operator instead of waiting for it.`,
      not_enabled: `The browser ${describe(browser)} is not enabled in this workspace any more. Report this to the operator.`,
      outdated:
        `The extension in the browser ${describe(browser)} is too old to work through: its owner has to update it — download the current one on the ` +
        'Connections screen of the console, unpack it over the old one and press Reload on chrome://extensions. Report this to the operator.',
    };

    return new Error(said[error.code]);
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

const liveLink = (workspaceId: string, session: { clientName: string; label(): Promise<string>; about?(): Promise<SessionAbout> }): UserBrowserLink => ({
  browsers: () => workspaceBrowsers(workspaceId),
  tabs: browserId => workspaceBrowserTabs(workspaceId, browserId),
  open: async browserId => openBrowserSession({ workspaceId, browserId, clientName: session.clientName, label: await session.label(), about: await session.about?.() }),
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
  // What the user reads about the session in their browser: in one line,
  // and the workspace and the thread apart.
  label(): Promise<string>;
  about?(): Promise<SessionAbout>;
  link?: UserBrowserLink;
  // How long a session stands unused before it is parked.
  idleParkMs?: number;
}): UserBrowser {
  const link = options.link ?? liveLink(options.workspaceId, options);
  const idleParkMs = options.idleParkMs ?? IDLE_PARK_MS;
  // The browser the agent named: the next session opens there.
  let chosen: WorkspaceBrowser | null = null;
  let current: Held | null = null;
  let opening: Promise<Held> | null = null;
  // The session is parked, on its way there, or on its way back.
  let resting: Resting | null = null;
  let parking: Promise<void> | null = null;
  let waking: Promise<Held> | null = null;
  // Why the last session ended, when it was not this run that ended it.
  let ended: string | null = null;
  // The extension took a tab from the session, and the agent has not heard yet.
  let tabTaken = false;
  // The browser calls in flight, and the clock of the session's idleness.
  let inUse = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let disposed = false;
  // The kit's own tool of tabs: tells and sets the tab the kit works in.
  let tabsTool: SessionEnvironmentTool | null = null;
  // After a session came back: the number of the tab to make current again,
  // and what the agent has to hear — instead of what it asked for, when the
  // tabs are not the ones it knew (`halt`).
  let reselect: number | null = null;
  let note: string | null = null;
  let halt = false;

  const pick = async (wanted: Wanted | null): Promise<WorkspaceBrowser> => {
    const candidates = await link.browsers();

    // The browser named before stays the choice while it is the workspace's.
    if (!wanted && chosen) {
      const remembered = candidates.find(browser => browser.id === chosen!.id);

      if (remembered) {
        return remembered;
      }

      // Not replaced by whichever is left: that one is another's to offer.
      throw new Error(
        `The browser you chose, ${describe(chosen)}, is not linked to this workspace any more: its owner disconnected it or switched it off here. ` +
          'Report this to the operator; another browser is taken only by naming it with user_browser_connect. ' +
          (candidates.length ? `The linked browsers:\n${listing(candidates)}` : 'No browser is linked to this workspace now.'),
      );
    }

    const choice = chooseBrowser(candidates, wanted);

    if ('refusal' in choice) {
      throw new Error(choice.refusal);
    }

    return choice.browser;
  };

  // The Playwright client of a session that has just been opened or has
  // come back; from here on the session is the one the run holds.
  const hold = async (browser: WorkspaceBrowser, session: BrowserSession): Promise<Held> => {
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
  };

  const open = (browser: WorkspaceBrowser): Promise<Held> => {
    opening ??= (async (): Promise<Held> => {
      const session = await link.open(browser.id).catch(error => {
        throw accessRefusal(error, browser);
      });

      // A new session owes nothing to the one before it.
      reselect = null;
      note = null;
      halt = false;

      return hold(browser, session);
    })().finally(() => {
      opening = null;
    });

    return opening;
  };

  // The tab the kit works in, among the tabs of the session in the kit's
  // numbering; null when the kit does not tell.
  const frontTab = async (order: number[]): Promise<number | null> => {
    if (order.length < 2 || !tabsTool) {
      return order.length === 1 ? order[0] : null;
    }

    const listed = currentTabOf(String(await tabsTool.handler({ action: 'list' }).catch(() => '')));

    return listed && listed.count === order.length ? order[listed.index] : null;
  };

  const park = async (held: Held): Promise<void> => {
    const order = held.session.tabIds();
    const front = await frontTab(order);

    if (current !== held) {
      return;
    }

    let parked: ParkedBrowserSession;

    try {
      parked = await held.session.park();
    } catch (error) {
      // The refusal ended the session as lost, and the run has heard so.
      console.warn(`[user-browser] the session in the browser ${describe(held.browser)} was not parked:`, error);

      return;
    }

    if (current === held) {
      current = null;
    }

    resting = { browser: held.browser, parked, order, front };
    void held.detach().catch(() => {});
    void parked.ended.then(({ end }) => {
      if (resting?.parked === parked) {
        resting = null;
        ended = end === 'closed' ? null : sessionEndText(end, held.browser);
      }
    });
  };

  const wake = (): Promise<Held> => {
    waking ??= (async (): Promise<Held> => {
      const { browser, parked, order, front } = resting!;
      // Before the session is touched: without its label it stays parked, and the next call tries again.
      const unread = (error: unknown): never => {
        throw new Error(`The session was not brought back: its label could not be read (${error instanceof Error ? error.message : String(error)}). Try again.`);
      };
      const label = await options.label().catch(unread);
      const about = await options.about?.().catch(unread);
      let session: BrowserSession;

      try {
        session = await parked.resume({ clientName: options.clientName, label, about, tabIds: order });
      } catch (error) {
        // A session that did not come back is over, and the link says how.
        const { end } = await parked.ended;

        if (resting?.parked === parked) {
          resting = null;
          ended = sessionEndText(end === 'closed' ? 'lost' : end, browser);
        }

        throw new Error(ended ?? sessionEndText('lost', browser));
      }

      resting = null;

      const held = await hold(browser, session).catch(error => {
        ended = sessionEndText('lost', browser);

        throw error;
      });
      const now = session.tabIds();
      const gone = order.filter(tabId => !now.includes(tabId));
      const frontNow = front === null ? -1 : now.indexOf(front);

      // The kit starts on the first of the tabs.
      reselect = frontNow > 0 ? frontNow : null;
      note = gone.length ? tabsGoneText(gone.length, front !== null && frontNow === -1) : null;
      halt = gone.length > 0;

      return held;
    })().finally(() => {
      waking = null;
    });

    return waking;
  };

  const startIdleClock = () => {
    clearTimeout(idleTimer);

    if (disposed || !current) {
      return;
    }

    idleTimer = setTimeout(() => {
      const held = current;

      if (held && inUse === 0 && !parking) {
        parking = park(held).finally(() => {
          parking = null;
        });
      }
    }, idleParkMs);
    idleTimer.unref();
  };

  // A call that works in the session: the session is not parked under it,
  // and a parking under way is over before it starts.
  const using = async <T>(work: () => Promise<T>): Promise<T> => {
    inUse += 1;
    clearTimeout(idleTimer);

    try {
      await parking;

      return await work();
    } finally {
      inUse -= 1;

      if (inUse === 0) {
        startIdleClock();
      }
    }
  };

  // The session the call works in: the open one, the parked one brought
  // back, or a new one.
  const session = async (): Promise<Held> => {
    if (current) {
      return current;
    }

    if (resting || waking) {
      return wake();
    }

    if (ended) {
      throw new Error(ended);
    }

    return opening ?? open(await pick(null));
  };

  const close = async () => {
    clearTimeout(idleTimer);
    await parking?.catch(() => {});

    if (resting && !waking) {
      const { parked } = resting;

      // Ended by this run: no reason to keep.
      resting = null;
      parked.close();

      return;
    }

    const held = current ?? (await (waking ?? opening)?.catch(() => null));

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

    if ((current ?? resting)?.browser.id === browser.id) {
      await session();

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

  // What the agent has to hear after a session came back, with the result
  // or the failure of the call that brought it back.
  const told = (text: string): string => {
    if (!note) {
      return text;
    }

    const said = note;

    note = null;

    return `${said}\n\n${text}`;
  };

  return {
    context: async () => (await session()).context,

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
            session: (current ?? resting)?.browser.id === browser.id,
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
        handler: async args => using(() => connect(wantedOf(args))),
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
          const browser = (current ?? resting)?.browser ?? (await pick(null));
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

          const tabId = args.tabId;

          return using(async () => {
            const held = await session();

            await held.session.claimTab(tabId).catch(error => {
              throw accessRefusal(error, held.browser);
            });

            return 'The user handed the tab over: it is in your session now, and browser_tabs lists it.';
          });
        },
      },
    ],

    guard: tool => {
      if (tool.name === 'browser_tabs') {
        tabsTool = tool;
      }

      return {
        ...tool,
        handler: args =>
          using(async () => {
            if (!current && !resting && ended) {
              throw new Error(ended);
            }

            // Before the kit asks for its context: what the return changes is set right first.
            if (resting || waking) {
              await wake();
            }

            // Told once, before the agent goes on as if the tab were there.
            if (current && tabTaken) {
              tabTaken = false;

              throw new Error(TAB_TAKEN_TEXT);
            }

            if (reselect !== null && tabsTool) {
              const index = reselect;

              reselect = null;
              // The kit learns the tabs of its new client when it is asked for them.
              await tabsTool
                .handler({ action: 'list' })
                .then(() => tabsTool!.handler({ action: 'select', index }))
                .catch(error => {
                  console.warn('[user-browser] the tab the agent worked in was not made current again:', error);
                  note ??= 'Your session was parked and is back, but the tab you were working in could not be made current again.';
                  halt = true;
                });
            }

            // The tabs are not the ones the agent knew: it hears so before
            // anything is done in a tab it did not mean. Listing them is what
            // it is told to do.
            if (halt) {
              halt = false;

              if (!(tool.name === 'browser_tabs' && args.action === 'list')) {
                throw new Error(`${told('')}${NOT_DONE_TEXT}`);
              }
            }

            try {
              const result = await tool.handler(args);

              return typeof result === 'string' ? told(result) : result;
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

              throw note ? new Error(told(error instanceof Error ? error.message : String(error))) : error;
            }
          }),
      };
    },

    dispose: async () => {
      disposed = true;
      await close();
    },
  };
}
