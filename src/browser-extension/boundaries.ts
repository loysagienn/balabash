// What the user keeps away from the agent, held and applied on the user's
// machine: neither an agent a page talked round nor the server can lift it.
//
// The settings — the blocked list of sites, whether the agent sees the list
// of tabs and whether it gets a tab it asks for without the user being
// asked — live in chrome.storage.local and are written by this module alone
// (the popup asks the worker). Every change is one action that saves
// itself: a switch, a site added, an entry rewritten, an entry removed —
// there is no draft of the list that another change could carry along.
//
// A blocked site is closed to a session at every door:
// - its tabs are not in the list of tabs and cannot be handed to a session
//   (link.ts asks isBlockedUrl);
// - a session does not open it: a new tab and Page.navigate with its
//   address are refused (checkNewTab, checkSessionCommand — called by
//   playwright/clientSession.ts);
// - a tab that shows it belongs to no session. Such a tab is "reserved" in
//   the registry of the Playwright modules: reserving takes it from its
//   owner — the session's tab went there by a link or a redirect — nobody
//   can claim it, and the group manager puts it out of a session's group
//   when the user drags it in. The session it was taken from is told.
// A blocked site inside a frame of another page is not caught.
//
// The pages of extensions are closed to a session the same way and at the
// same doors, whatever the settings (isOffLimits): a page of this extension
// has the extension's own rights — the settings above, the secret of the
// pairing, the debugger on any tab — and Chrome lets an extension debug its
// own pages.
//
// Besides the sites, a session may not read the cookies of the profile
// through the debugger — neither by the commands that return them nor in
// what the debugger says about the network (../browser-link/cdp-cookies.ts)
// — nor close or crash the browser.

import { withoutCookies } from '../browser-link/cdp-cookies.ts';
import { isBlockedUrl, isExtensionPage, normalizeSite, normalizeSites } from '../browser-link/sites.ts';
import type { ChromeListeners } from './playwright/chromeListeners';
import type { ClientSession } from './playwright/clientSession';
import type { TabGroupManager } from './playwright/tabGroupManager';
import type { TabRegistry } from './playwright/tabRegistry';

export type Settings = {
  // Domains; an entry covers its subdomains.
  blockedSites: string[];
  // The agent does not get the list of the user's tabs.
  tabsListHidden: boolean;
  // A tab a session asks for is handed over without the consent window.
  // The blocked sites stay closed all the same.
  tabsWithoutAsking: boolean;
};

const BLOCKED_SITE = "This site is on the user's list of blocked sites";
const EXTENSION_PAGE = 'The pages of extensions are closed to a session';

// The debugger would give a session the cookies of the whole profile, and
// the means to end the browser itself.
const DENIED_METHODS = new Map<string, string>([
  ['Storage.getCookies', 'reading cookies through the debugger is not allowed'],
  ['Network.getCookies', 'reading cookies through the debugger is not allowed'],
  ['Network.getAllCookies', 'reading cookies through the debugger is not allowed'],
  ['Page.getCookies', 'reading cookies through the debugger is not allowed'],
  ['Browser.close', 'closing the browser is not allowed'],
  ['Browser.crash', 'closing the browser is not allowed'],
  ['Browser.crashGpuProcess', 'closing the browser is not allowed'],
]);

let settings: Settings = { blockedSites: [], tabsListHidden: false, tabsWithoutAsking: false };
let registry: TabRegistry | undefined;
let groups: TabGroupManager | undefined;
let onTabTaken: ((session: ClientSession, tabId: number) => void) | undefined;

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get(['blockedSites', 'tabsListHidden', 'tabsWithoutAsking']);

  settings = {
    blockedSites: Array.isArray(stored.blockedSites) ? normalizeSites(stored.blockedSites.filter(site => typeof site === 'string')) : [],
    tabsListHidden: stored.tabsListHidden === true,
    tabsWithoutAsking: stored.tabsWithoutAsking === true,
  };
}

// The settings are read once per start of the worker.
const loaded = load();

export async function readSettings(): Promise<Settings> {
  await loaded;

  return settings;
}

async function keep(next: Settings): Promise<Settings> {
  await chrome.storage.local.set(next);
  settings = next;
  // A site blocked just now takes its tabs from the sessions at once.
  await applyToAllTabs();

  return settings;
}

// A switch, or both: each named one takes its value, the rest stay.
export async function writeSwitches(next: { tabsListHidden?: unknown; tabsWithoutAsking?: unknown }): Promise<Settings> {
  await loaded;

  return await keep({
    ...settings,
    tabsListHidden: typeof next.tabsListHidden === 'boolean' ? next.tabsListHidden : settings.tabsListHidden,
    tabsWithoutAsking: typeof next.tabsWithoutAsking === 'boolean' ? next.tabsWithoutAsking : settings.tabsWithoutAsking,
  });
}

// One change of the blocked list. What the user typed keeps its domain
// only; `invalid_site` — it names none. A site that is on the list already
// is not added twice, and an entry rewritten into another entry joins it.
export type SitesChange = { add: string } | { remove: string } | { replace: string; with: string };

export type SitesResult = { ok: true; settings: Settings } | { ok: false; error: 'invalid_site' };

export async function changeSites(change: SitesChange): Promise<SitesResult> {
  await loaded;

  let sites: string[];

  if ('add' in change) {
    const site = normalizeSite(String(change.add));

    if (!site) {
      return { ok: false, error: 'invalid_site' };
    }

    sites = [...settings.blockedSites, site];
  } else if ('remove' in change) {
    sites = settings.blockedSites.filter(entry => entry !== change.remove);
  } else {
    const site = normalizeSite(String(change.with));

    if (!site) {
      return { ok: false, error: 'invalid_site' };
    }

    sites = settings.blockedSites.map(entry => (entry === change.replace ? site : entry));
  }

  return { ok: true, settings: await keep({ ...settings, blockedSites: normalizeSites(sites) }) };
}

export function isBlocked(url: string | undefined): boolean {
  return isBlockedUrl(url, settings.blockedSites);
}

// A tab with this address is nobody's: a blocked site, or a page of an extension.
export function isOffLimits(url: string | undefined): boolean {
  return isExtensionPage(url) || isBlocked(url);
}

export function blockedSiteError(): Error {
  return Object.assign(new Error(BLOCKED_SITE), { code: 'blocked_site' });
}

// A tab the session asks to open.
export function checkNewTab(url: unknown): void {
  if (typeof url !== 'string') {
    return;
  }

  if (isExtensionPage(url)) {
    throw Object.assign(new Error(EXTENSION_PAGE), { code: 'not_debuggable' });
  }

  if (isBlocked(url)) {
    throw blockedSiteError();
  }
}

// A CDP command of a session, before it reaches the debugger.
export function checkSessionCommand(method: string, params: { url?: unknown } | undefined): void {
  const denied = DENIED_METHODS.get(method);

  if (denied) {
    throw new Error(`${method} is not allowed: ${denied}`);
  }

  if (method === 'Page.navigate') {
    checkNewTab(params?.url);
  }
}

// What the debugger says to a session — the params of an event, the result
// of a command — before it leaves the browser.
export function forSession<T>(method: string, payload: T): T {
  return withoutCookies(method, payload);
}

// Brings one tab in line with the boundaries: a tab of a blocked site, or
// one that shows a page of an extension, is nobody's.
async function apply(tabId: number, url: string | undefined): Promise<void> {
  if (!registry) {
    return;
  }

  if (!isOffLimits(url)) {
    registry.unreserve(tabId);

    return;
  }

  const owner = registry.ownerOf(tabId);

  await registry.reserve(tabId);

  if (owner) {
    await groups?.ungroup(tabId);
    onTabTaken?.(owner, tabId);
  }
}

// Every tab of the browser, when a session starts or the list changes.
export async function applyToAllTabs(): Promise<void> {
  await loaded;

  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined) {
      await apply(tab.id, tab.url ?? tab.pendingUrl);
    }
  }
}

// `taken` hears of a tab taken from a session because it went to a blocked site.
export function watchTabs(options: {
  registry: TabRegistry;
  groups: TabGroupManager;
  listeners: ChromeListeners;
  taken(session: ClientSession, tabId: number): void;
}): void {
  registry = options.registry;
  groups = options.groups;
  onTabTaken = options.taken;
  // After the listeners of the registry: a tab a session's page opened is
  // claimed first and taken here.
  options.listeners.add(chrome.tabs.onCreated, tab => {
    if (tab.id !== undefined) {
      void apply(tab.id, tab.pendingUrl ?? tab.url);
    }
  });
  options.listeners.add(chrome.tabs.onUpdated, (tabId, changeInfo) => {
    if (changeInfo.url !== undefined) {
      void apply(tabId, changeInfo.url);
    }
  });
}
