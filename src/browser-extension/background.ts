// The service worker of the extension: wires the modules, keeps the link to
// the server alive across Chrome stopping the worker, and answers the pages
// that may talk to the extension.
//
// Chrome stops an idle worker and starts it again only for an event that
// has a listener registered at the top level of this file: the start of the
// browser, the installation, a message of the console page or of the
// extension's own page — and the alarm, which is the one that brings a
// dropped link back when nothing else happens. The alarm runs only while
// there is a link to bring back: a browser that is not paired or is paused
// lets the worker sleep.
//
// Two kinds of pages talk to the worker. The console
// (`externally_connectable` of the manifest names its origin, and the
// sender's origin is compared again here) asks what this extension is and
// hands over a pairing code (src/browser-link/protocol.ts). The extension's
// own options page asks for the status and switches the pause.

import { ChromeListeners } from './playwright/chromeListeners';
import { TabGroupManager } from './playwright/tabGroupManager';
import { TabRegistry } from './playwright/tabRegistry';
import { Link } from './link.ts';
import type { PagePairResult, PageRequest, PageStatus } from '../browser-link/protocol.ts';

const ALARM = 'browser-link';
// The shortest period Chrome allows.
const ALARM_PERIOD_MINUTES = 0.5;

// What the options page asks.
export type OwnPageRequest = { type: 'status' } | { type: 'setPaused'; paused: boolean };

const listeners = new ChromeListeners();
const registry = new TabRegistry(listeners);
const groups = new TabGroupManager(registry, listeners);
const link = new Link(registry, groups, listeners);

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
chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());

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

chrome.runtime.onMessage.addListener((message: OwnPageRequest, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || (message?.type !== 'status' && message?.type !== 'setPaused')) {
    return false;
  }

  const done = message.type === 'setPaused' ? link.setPaused(message.paused === true).then(wake) : Promise.resolve();

  done.then(() => link.status()).then(sendResponse, () => sendResponse(undefined));

  return true;
});

// Every start of the worker, whatever woke it.
void wake();
