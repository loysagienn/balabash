// The options page: what the link is doing now, the name the console gave
// this browser, and the pause. Everything it shows and changes goes through
// the worker (background.ts).

import type { OwnPageRequest } from './background.ts';
import type { LinkStatus } from './link.ts';

const field = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const status = field<HTMLDivElement>('status');
const paused = field<HTMLInputElement>('paused');
const consoleLink = field<HTMLAnchorElement>('console');

const STATE_TEXT: Record<LinkStatus['state'], string> = {
  unpaired: 'This browser is not connected. Open Connections in the Balabash console in this browser and press "Connect this browser".',
  paused: 'Paused: the server cannot reach this browser.',
  connecting: 'Connecting…',
  connected: 'Connected.',
  offline: 'Not connected, trying again.',
};

const ask = (request: OwnPageRequest): Promise<LinkStatus | undefined> => chrome.runtime.sendMessage(request).catch(() => undefined);

function show(current: LinkStatus | undefined): void {
  if (!current) {
    return;
  }

  const lines = [
    current.name ? `${current.name} — ${STATE_TEXT[current.state]}` : STATE_TEXT[current.state],
    current.detail,
    current.outdated ? 'A newer version of the extension is available in the console.' : '',
    ...current.sessions.map(session => `${session.label}: ${session.tabIds.length} tab(s)`),
  ];

  status.dataset.state = current.state;
  status.textContent = lines.filter(Boolean).join('\n');
  paused.checked = current.state === 'paused';
  paused.disabled = current.state === 'unpaired';
}

consoleLink.href = `${__CONSOLE_ORIGIN__}/`;
consoleLink.textContent = new URL(__CONSOLE_ORIGIN__).host;
paused.addEventListener('change', () => void ask({ type: 'setPaused', paused: paused.checked }).then(show));
setInterval(() => void ask({ type: 'status' }).then(show), 1000);
void ask({ type: 'status' }).then(show);
