// How the toolbar button looks for a state of the link (link.ts → action.ts
// shows it), pure: the image, the badge and the words of the tooltip — for
// the button at large and for the tabs agents hold.
//
// The mark is in color only while the server can reach the browser and an
// agent can work in it. The badge: "…" — no link yet or none now; "!" — the
// extension has to be updated; the number of sessions — green while one of
// them works, grey when all are idle. On a tab of a session it is "B" in the
// color of that tab's group. A pause is drawn into the image.

import { startOf } from './group-title.ts';
import type { LinkStatus, SessionView } from './link.ts';

export type ActionImage = 'color' | 'muted' | 'paused';

// `text` '' — no badge.
export type ActionBadge = { text: string; color: string; ink: string };

export type ActionLook = {
  image: ActionImage;
  badge: ActionBadge;
  title: string;
  // The tabs of the sessions, each with the mark of its group.
  tabs: Map<number, { badge: ActionBadge; title: string }>;
};

const NAME = 'Balabash Agent';
const INK_LIGHT = '#ffffff';
const INK_DARK = '#202124';
const GREY = '#5f6368';
const GREEN = '#188038';
const AMBER = '#f9ab00';
const NO_BADGE: ActionBadge = { text: '', color: GREY, ink: INK_LIGHT };

// Chrome's colors of tab groups, as a dark tab strip shows them.
const GROUP_COLORS: Record<string, string> = {
  grey: '#dadce0',
  blue: '#8ab4f8',
  red: '#f28b82',
  yellow: '#fdd663',
  green: '#81c995',
  pink: '#ff8bcb',
  purple: '#d7aefb',
  cyan: '#78d9ec',
  orange: '#fcad70',
};

// How much of a thread's title the tooltip of a tab gets.
const THREAD_IN_TITLE = 32;

function counted(count: number, word: string): string {
  return `${count} ${word}`;
}

function sessionsTitle(sessions: SessionView[]): string {
  const working = sessions.filter(session => !session.parked).length;
  const idle = sessions.length - working;

  if (working === 0) {
    return `${NAME} — ${counted(idle, idle === 1 ? 'idle session' : 'idle sessions')}. ${idle === 1 ? 'It comes' : 'They come'} back to ${idle === 1 ? 'its' : 'their'} tabs on ${idle === 1 ? 'its' : 'their'} own.`;
  }

  return `${NAME} — ${[counted(working, 'working'), idle ? counted(idle, 'idle') : ''].filter(Boolean).join(', ')}.`;
}

function tabTitle(session: SessionView): string {
  const thread = startOf(session.thread, THREAD_IN_TITLE) || 'an agent';

  return `This tab is with “${thread}”${session.workspace ? ` (${session.workspace})` : ''} — ${session.parked ? 'idle' : 'working'}.`;
}

function general(status: LinkStatus): Omit<ActionLook, 'tabs'> {
  if (status.state === 'unpaired') {
    return { image: 'muted', badge: NO_BADGE, title: `${NAME} — not connected. Open Connections in the console to connect.` };
  }

  if (status.state === 'paused') {
    return { image: 'paused', badge: NO_BADGE, title: `${NAME} — paused. The server can’t reach this browser.` };
  }

  if (status.update === 'needed') {
    return { image: 'muted', badge: { text: '!', color: AMBER, ink: INK_DARK }, title: `${NAME} — the server needs a newer extension. Get it in the console.` };
  }

  if (status.state === 'connecting' || status.state === 'offline') {
    const waiting: ActionBadge = { text: '…', color: GREY, ink: INK_LIGHT };

    return status.state === 'connecting'
      ? { image: 'muted', badge: waiting, title: `${NAME} — connecting…` }
      : { image: 'muted', badge: waiting, title: `${NAME} — no link to the server, retrying.${status.detail ? ` Last try: ${lowerFirst(status.detail)}.` : ''}` };
  }

  if (status.sessions.length === 0) {
    return { image: 'color', badge: NO_BADGE, title: status.name ? `${NAME} — connected as “${status.name}”.` : `${NAME} — connected.` };
  }

  const working = status.sessions.some(session => !session.parked);

  return {
    image: 'color',
    badge: { text: String(status.sessions.length), color: working ? GREEN : GREY, ink: INK_LIGHT },
    title: sessionsTitle(status.sessions),
  };
}

// "The server is not reachable" → "the server is not reachable", after "Last try:".
export function lowerFirst(text: string): string {
  const line = text.trim().replace(/[.\s]+$/, '');

  return line.charAt(0).toLowerCase() + line.slice(1);
}

export function actionLook(status: LinkStatus): ActionLook {
  const tabs = new Map<number, { badge: ActionBadge; title: string }>();

  for (const session of status.sessions) {
    for (const tabId of session.tabIds) {
      tabs.set(tabId, {
        badge: { text: 'B', color: GROUP_COLORS[session.group.color] ?? GROUP_COLORS.grey!, ink: INK_DARK },
        title: tabTitle(session),
      });
    }
  }

  return { ...general(status), tabs };
}
