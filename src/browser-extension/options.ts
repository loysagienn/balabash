// The options page: the link and its pause, and the user's boundaries — the
// sites the agent is kept away from, whether it sees the list of tabs and
// whether it is handed a tab it asks for without the user being asked.
// Everything it shows and changes goes through the worker (background.ts).

import { ask, field, followStatus, statusLines } from './pages.ts';
import type { Settings } from './boundaries.ts';
import type { LinkStatus } from './link.ts';

const status = field<HTMLDivElement>('status');
const paused = field<HTMLInputElement>('paused');
const consoleLink = field<HTMLAnchorElement>('console');
const blockedSites = field<HTMLTextAreaElement>('blocked-sites');
const tabsList = field<HTMLInputElement>('tabs-list');
const withoutAsking = field<HTMLInputElement>('without-asking');
const save = field<HTMLButtonElement>('save');
const saved = field<HTMLSpanElement>('saved');

function show(current: LinkStatus | undefined): void {
  if (!current) {
    return;
  }

  status.dataset.state = current.state;
  status.textContent = [...statusLines(current), ...current.sessions.map(session => `${session.label}: ${session.tabIds.length} tab(s)`)].join('\n');
  paused.checked = current.state === 'paused';
  paused.disabled = current.state === 'unpaired';
}

function showSettings(settings: Settings | undefined): void {
  if (!settings) {
    return;
  }

  blockedSites.value = settings.blockedSites.join('\n');
  tabsList.checked = !settings.tabsListHidden;
  withoutAsking.checked = settings.tabsWithoutAsking;
}

consoleLink.href = `${__CONSOLE_ORIGIN__}/`;
consoleLink.textContent = new URL(__CONSOLE_ORIGIN__).host;
const following = followStatus(show);

paused.addEventListener('change', () => {
  following.changed();
  void ask({ type: 'setPaused', paused: paused.checked }).then(show);
});
save.addEventListener('click', () => {
  saved.textContent = '';
  void ask({ type: 'setSettings', blockedSites: blockedSites.value.split('\n'), tabsListHidden: !tabsList.checked, tabsWithoutAsking: withoutAsking.checked }).then(settings => {
    // What was kept: the entries as the list holds them.
    showSettings(settings);
    saved.textContent = settings ? 'Saved.' : 'Not saved: the extension did not answer.';
  });
});
void ask({ type: 'getSettings' }).then(showSettings);
