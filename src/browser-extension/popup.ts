// The popup of the toolbar button — the one page the user meets the
// extension on: what the link is doing and the pause; the sessions agents
// hold in this browser, each with its label and tabs, a button that stops
// it and one that hands it the tab in front; and the user's boundaries
// (boundaries.ts) — whether the agent sees the list of tabs, whether it is
// handed a tab without the user being asked, the blocked sites. Everything
// goes through the worker (background.ts).
//
// A popup closes as soon as the user clicks elsewhere, so a switch is saved
// the moment it is flipped; the list of sites, which is typed, has a Save.

import { ask, field, followStatus, statusLines } from './pages.ts';
import type { Settings } from './boundaries.ts';
import type { LinkStatus } from './link.ts';

const status = field<HTMLDivElement>('status');
const paused = field<HTMLInputElement>('paused');
const stopAll = field<HTMLButtonElement>('stop-all');
const sessions = field<HTMLDivElement>('sessions');
const error = field<HTMLDivElement>('error');
const consoleLink = field<HTMLAnchorElement>('console');
const blockedSites = field<HTMLTextAreaElement>('blocked-sites');
const tabsList = field<HTMLInputElement>('tabs-list');
const withoutAsking = field<HTMLInputElement>('without-asking');
const save = field<HTMLButtonElement>('save');
const saved = field<HTMLSpanElement>('saved');

// The tab the popup was opened over.
async function tabInFront(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  return tab;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');

  element.type = 'button';
  element.textContent = text;
  element.addEventListener('click', onClick);

  return element;
}

let shown = '';

async function show(current: LinkStatus | undefined): Promise<void> {
  if (!current) {
    return;
  }

  status.dataset.state = current.state;
  status.textContent = statusLines(current).join('\n');
  paused.checked = current.state === 'paused';
  paused.disabled = current.state === 'unpaired';
  stopAll.hidden = current.sessions.length < 2;

  const front = await tabInFront();
  // The list is rebuilt only when it changed: a click must find its button.
  const signature = JSON.stringify([current.sessions, front?.id]);

  if (signature === shown) {
    return;
  }

  shown = signature;
  sessions.replaceChildren(
    ...current.sessions.map(session => {
      const block = document.createElement('div');
      const label = document.createElement('div');
      const tabs = document.createElement('div');
      const actions = document.createElement('div');

      block.className = 'session';
      block.dataset.session = String(session.id);
      label.className = 'label';
      label.textContent = session.label;
      tabs.className = 'tabs';
      tabs.textContent = `${session.tabIds.length} tab(s)`;
      actions.className = 'actions';
      actions.append(
        button('Stop', () => {
          following.changed();
          void ask({ type: 'stopSessions', sessionId: session.id }).then(show);
        }),
      );

      if (front?.id !== undefined && !session.tabIds.includes(front.id)) {
        actions.append(
          button('Hand this tab to the agent', () => {
            error.textContent = '';
            void ask({ type: 'handTab', sessionId: session.id, tabId: front.id! }).then(answer => {
              if (answer && !answer.ok) {
                error.textContent = answer.error;
              }
            });
          }),
        );
      }

      block.append(label, tabs, actions);

      return block;
    }),
  );
}

function showSettings(settings: Settings | undefined): void {
  if (!settings) {
    return;
  }

  blockedSites.value = settings.blockedSites.join('\n');
  tabsList.checked = !settings.tabsListHidden;
  withoutAsking.checked = settings.tabsWithoutAsking;
}

// Everything on the page, as it stands; the answer is what was kept — the
// sites as the list holds them.
function saveSettings(): void {
  saved.textContent = '';
  void ask({
    type: 'setSettings',
    blockedSites: blockedSites.value.split('\n'),
    tabsListHidden: !tabsList.checked,
    tabsWithoutAsking: withoutAsking.checked,
  }).then(settings => {
    showSettings(settings);
    saved.textContent = settings ? 'Saved.' : 'Not saved: the extension did not answer.';
  });
}

const following = followStatus(show);

consoleLink.href = `${__CONSOLE_ORIGIN__}/`;
paused.addEventListener('change', () => {
  following.changed();
  void ask({ type: 'setPaused', paused: paused.checked }).then(show);
});
stopAll.addEventListener('click', () => {
  following.changed();
  void ask({ type: 'stopSessions' }).then(show);
});
tabsList.addEventListener('change', saveSettings);
withoutAsking.addEventListener('change', saveSettings);
save.addEventListener('click', saveSettings);
void ask({ type: 'getSettings' }).then(showSettings);
