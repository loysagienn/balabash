// How the group of tabs of a session is named in the tab strip: "B · " and
// the start of the title of the agent's thread while the session lives,
// "Ended · …" once it is over (the group turns grey then,
// playwright/tabGroupManager.ts). The popup heads a session with the same
// words. Nothing here touches chrome.

export const LIVE_PREFIX = 'B · ';
export const ENDED_PREFIX = 'Ended · ';
// How much of the thread's title the tab strip gets.
const THREAD_LENGTH = 20;
// A session whose thread has no title yet.
const UNTITLED = 'Balabash';

// The start of a title, cut at `length` characters with an ellipsis.
export function startOf(text: string, length: number): string {
  const line = text.trim().replace(/\s+/g, ' ');

  return line.length > length ? `${line.slice(0, length).trimEnd()}…` : line;
}

export function groupTitle(thread: string): string {
  const start = startOf(thread, THREAD_LENGTH);

  return start ? `${LIVE_PREFIX}${start}` : UNTITLED;
}

// The title of a group whose session ended, from the one it had.
export function endedTitle(title: string | undefined): string {
  const name = (title ?? '').trim();

  if (name.startsWith(ENDED_PREFIX)) {
    return name;
  }

  return `${ENDED_PREFIX}${name.startsWith(LIVE_PREFIX) ? name.slice(LIVE_PREFIX.length) : name}`.trim();
}
