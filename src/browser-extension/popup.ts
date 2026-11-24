// The popup of the toolbar button: what the link is doing, the pause, and
// the sessions agents hold in this browser — each with its label and tabs,
// a button that stops it and one that hands it the tab in front. Everything
// goes through the worker (background.ts).

import { ask, field, followStatus, statusLines } from './pages.ts';
import type { LinkStatus } from './link.ts';

const status = field<HTMLDivElement>('status');
const paused = field<HTMLInputElement>('paused');
const stopAll = field<HTMLButtonElement>('stop-all');
const sessions = field<HTMLDivElement>('sessions');
const error = field<HTMLDivElement>('error');
const consoleLink = field<HTMLAnchorElement>('console');

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

consoleLink.href = `${__CONSOLE_ORIGIN__}/`;
const following = followStatus(show);

paused.addEventListener('change', () => {
  following.changed();
  void ask({ type: 'setPaused', paused: paused.checked }).then(show);
});
stopAll.addEventListener('click', () => {
  following.changed();
  void ask({ type: 'stopSessions' }).then(show);
});
field<HTMLAnchorElement>('settings').addEventListener('click', event => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage();
});
