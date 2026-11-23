// The service worker of the extension: wires the modules and keeps the link
// to the server alive across Chrome stopping the worker.
//
// Chrome stops an idle worker and starts it again only for an event that
// has a listener registered at the top level of this file: the start of the
// browser, the installation, a change of the settings, a message of the
// options page — and the alarm, which is the one that brings a dropped link
// back when nothing else happens.

import { ChromeListeners } from './playwright/chromeListeners';
import { TabGroupManager } from './playwright/tabGroupManager';
import { TabRegistry } from './playwright/tabRegistry';
import { Link } from './link.ts';

const ALARM = 'browser-link';
// The shortest period Chrome allows.
const ALARM_PERIOD_MINUTES = 0.5;

const listeners = new ChromeListeners();
const registry = new TabRegistry(listeners);
const groups = new TabGroupManager(registry, listeners);
const link = new Link(registry, groups, listeners);

const wake = () => {
  void chrome.alarms.create(ALARM, { periodInMinutes: ALARM_PERIOD_MINUTES });
  void link.ensureConnected();
};

chrome.runtime.onStartup.addListener(wake);
chrome.runtime.onInstalled.addListener(wake);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) {
    void link.ensureConnected();
  }
});
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') {
    void link.restart();
  }
});
chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());

// Chrome does not support promise-based message handlers: https://issues.chromium.org/issues/40753031
chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
  if (message?.type !== 'status') {
    return false;
  }

  link.status().then(sendResponse, error => sendResponse({ state: 'offline', detail: String(error), sessions: [] }));

  return true;
});

// Every start of the worker, whatever woke it.
wake();
