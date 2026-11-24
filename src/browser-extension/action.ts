// The toolbar button of the extension: its image, badge and tooltip follow
// the link (action-look.ts says how each state looks). The button at large
// carries the state; a tab an agent holds carries the mark of its group.
//
// Chrome keeps what was set for one tab until that tab navigates, and has no
// way to take a tab's own title or badge color back: a tab that was marked
// once is told the general look again whenever it is not a session's. Which
// tabs were marked survives the worker in chrome.storage.session.

import { actionLook } from './action-look.ts';
import type { ActionBadge, ActionImage } from './action-look.ts';
import type { LinkStatus } from './link.ts';

const STORAGE_KEY = 'markedTabIds';
const REFRESH_DELAY_MS = 150;

const IMAGES: Record<ActionImage, Record<number, string>> = {
  color: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
  muted: { 16: 'icons/icon-16-muted.png', 32: 'icons/icon-32-muted.png' },
  paused: { 16: 'icons/icon-16-paused.png', 32: 'icons/icon-32-paused.png' },
};

async function setBadge(badge: ActionBadge, tabId?: number): Promise<void> {
  const tab = tabId === undefined ? {} : { tabId };

  await chrome.action.setBadgeText({ ...tab, text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ ...tab, color: badge.color });
  await chrome.action.setBadgeTextColor({ ...tab, color: badge.ink });
}

async function show(status: LinkStatus): Promise<void> {
  const look = actionLook(status);
  const { [STORAGE_KEY]: stored = [] } = await chrome.storage.session.get(STORAGE_KEY);
  const marked = new Set<number>([...(stored as number[]), ...look.tabs.keys()]);

  await chrome.action.setIcon({ path: IMAGES[look.image] });
  await setBadge(look.badge);
  await chrome.action.setTitle({ title: look.title });

  for (const tabId of [...marked]) {
    const own = look.tabs.get(tabId);

    try {
      await setBadge(own?.badge ?? look.badge, tabId);
      await chrome.action.setTitle({ tabId, title: own?.title ?? look.title });
    } catch {
      // The tab is closed.
      marked.delete(tabId);
    }
  }

  await chrome.storage.session.set({ [STORAGE_KEY]: [...marked] });
}

// Shows the state `read` answers, soon: changes that come together are
// shown once, and one showing at a time.
export function followLink(read: () => Promise<LinkStatus>): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let showing: Promise<void> = Promise.resolve();

  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      showing = showing.then(async () => show(await read())).catch(() => {});
    }, REFRESH_DELAY_MS);
  };
}
