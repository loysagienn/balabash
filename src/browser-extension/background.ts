// The service worker of the extension: wires the modules, keeps the link to
// the server alive across Chrome stopping the worker, and answers the pages
// that may talk to the extension.
//
// Chrome stops an idle worker and starts it again only for an event that
// has a listener registered at the top level of this file: the start of the
// browser, the installation, a message of the console page or of the
// extension's own pages — and the alarm, which is the one that brings a
// dropped link back when nothing else happens. The alarm runs only while
// there is a link to bring back: a browser that is not paired or is paused
// lets the worker sleep.
//
// Two kinds of pages talk to the worker. The console
// (`externally_connectable` of the manifest names its origin, and the
// sender's origin is compared again here) asks what this extension is and
// hands over a pairing code (src/browser-link/protocol.ts). The extension's
// own pages (OwnPageRequest): the popup of the toolbar button shows the
// link and its sessions, switches the pause, stops sessions and hands the
// tab in front to one; the options page keeps the user's boundaries
// (boundaries.ts); the consent window brings the user's answer about a tab
// a session asked for (consent.ts).

import { readSettings, watchTabs, writeSettings } from './boundaries.ts';
import type { Settings } from './boundaries.ts';
import { Consent } from './consent.ts';
import type { ConsentRequest } from './consent.ts';
import { ChromeListeners } from './playwright/chromeListeners';
import { TabGroupManager } from './playwright/tabGroupManager';
import { TabRegistry } from './playwright/tabRegistry';
import { Link } from './link.ts';
import type { LinkStatus } from './link.ts';
import type { PagePairResult, PageRequest, PageStatus } from '../browser-link/protocol.ts';

const ALARM = 'browser-link';
// The shortest period Chrome allows.
const ALARM_PERIOD_MINUTES = 0.5;

// What the extension's own pages ask, and what each is answered with.
export type OwnPageRequest =
  | { type: 'status' }
  | { type: 'setPaused'; paused: boolean }
  | { type: 'stopSessions'; sessionId?: number }
  | { type: 'handTab'; sessionId: number; tabId: number }
  | { type: 'getSettings' }
  | { type: 'setSettings'; blockedSites?: string[]; tabsListHidden?: boolean; tabsWithoutAsking?: boolean }
  | { type: 'consent.get'; id: string }
  | { type: 'consent.answer'; id: string; allow: boolean };

export type OwnPageAnswers = {
  status: LinkStatus;
  setPaused: LinkStatus;
  stopSessions: LinkStatus;
  // `error` — why the tab was not handed over, in words for the user.
  handTab: { ok: true } | { ok: false; error: string };
  getSettings: Settings;
  setSettings: Settings;
  // Null once the request is over.
  'consent.get': ConsentRequest | null;
  'consent.answer': null;
};

const OWN_REQUESTS = new Set<string>(['status', 'setPaused', 'stopSessions', 'handTab', 'getSettings', 'setSettings', 'consent.get', 'consent.answer']);

const listeners = new ChromeListeners();
const registry = new TabRegistry(listeners);
const groups = new TabGroupManager(registry, listeners);
const consent = new Consent(listeners);
const link = new Link(registry, groups, listeners, consent);

watchTabs({ registry, groups, listeners, taken: (session, tabId) => link.tabTaken(session, tabId) });

// Dials if there is whom to dial, and keeps the alarm only while there is.
async function wake(): Promise<void> {
  await link.ensureConnected();

  const { state } = await link.status();

  if (state === 'unpaired' || state === 'paused') {
    await chrome.alarms.clear(ALARM);
  } else if (!(await chrome.alarms.get(ALARM))) {
    await chrome.alarms.create(ALARM, { periodInMinutes: ALARM_PERIOD_MINUTES });
  }
}

chrome.runtime.onStartup.addListener(() => void wake());
chrome.runtime.onInstalled.addListener(() => void wake());
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) {
    void wake();
  }
});

async function answerConsole(message: PageRequest): Promise<PageStatus | PagePairResult> {
  if (message.type === 'pair' && typeof message.code === 'string' && message.code) {
    const result = await link.pair(message.code);

    await wake();

    return result;
  }

  const { state, browserId } = await link.status();

  return { version: chrome.runtime.getManifest().version, state, browserId };
}

// Chrome does not support promise-based message handlers: https://issues.chromium.org/issues/40753031
chrome.runtime.onMessageExternal.addListener((message: PageRequest, sender, sendResponse) => {
  if (sender.origin !== __CONSOLE_ORIGIN__ || (message?.type !== 'status' && message?.type !== 'pair')) {
    return false;
  }

  answerConsole(message).then(sendResponse, () => sendResponse(undefined));

  return true;
});

async function answerOwnPage(message: OwnPageRequest): Promise<OwnPageAnswers[OwnPageRequest['type']]> {
  switch (message.type) {
    case 'status':
      return await link.status();
    case 'setPaused':
      await link.setPaused(message.paused === true);
      await wake();

      return await link.status();
    case 'stopSessions':
      link.stopSessions(typeof message.sessionId === 'number' ? message.sessionId : undefined);

      return await link.status();
    case 'handTab':
      try {
        await link.handTab(message.sessionId, message.tabId);

        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    case 'getSettings':
      return await readSettings();
    case 'setSettings':
      return await writeSettings(message);
    case 'consent.get':
      return consent.describe(String(message.id)) ?? null;
    case 'consent.answer':
      consent.answer(String(message.id), message.allow === true);

      return null;
  }
}

chrome.runtime.onMessage.addListener((message: OwnPageRequest, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !OWN_REQUESTS.has(message?.type)) {
    return false;
  }

  answerOwnPage(message).then(sendResponse, () => sendResponse(undefined));

  return true;
});

// Every start of the worker, whatever woke it.
void wake();
