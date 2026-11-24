// What the extension's own pages share: asking the worker (background.ts)
// and the words for the states of the link.

import type { OwnPageAnswers, OwnPageRequest } from './background.ts';
import type { LinkStatus } from './link.ts';

export const field = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Undefined when the worker did not answer.
export function ask<R extends OwnPageRequest>(request: R): Promise<OwnPageAnswers[R['type']] | undefined> {
  return chrome.runtime.sendMessage(request).catch(() => undefined);
}

export const STATE_TEXT: Record<LinkStatus['state'], string> = {
  unpaired: 'This browser is not connected. Open Connections in the Balabash console in this browser and press "Connect this browser".',
  paused: 'Paused: the server cannot reach this browser.',
  connecting: 'Connecting…',
  connected: 'Connected.',
  offline: 'Not connected, trying again.',
};

// The lines about the link: the name with the state, why it is down, a newer version.
export function statusLines(current: LinkStatus): string[] {
  return [
    current.name ? `${current.name} — ${STATE_TEXT[current.state]}` : STATE_TEXT[current.state],
    current.detail,
    current.outdated ? 'A newer version of the extension is available in the console.' : '',
  ].filter(Boolean);
}

// Keeps a page's picture of the link fresh: asks every second and shows the
// answer — unless the user changed something meanwhile. An answer asked for
// before a change would put the control the user has just switched back.
export function followStatus(show: (current: LinkStatus | undefined) => unknown): { changed(): void } {
  let changes = 0;
  const poll = () => {
    const asked = changes;

    void ask({ type: 'status' }).then(current => {
      if (asked === changes) {
        void show(current);
      }
    });
  };

  setInterval(poll, 1000);
  poll();

  return {
    changed() {
      changes += 1;
    },
  };
}
