// The user's word on handing a tab to a session: a small window of the
// extension (consent.html) that says which session asks and for which tab,
// with Allow and Decline. Closing the window is a refusal; a minute without
// an answer is "no answer". The page of the window talks to the worker
// (background.ts) — it learns what is asked and brings the answer.

import type { ChromeListeners } from './playwright/chromeListeners';

const ANSWER_TIMEOUT_MS = 60_000;

export type ConsentRequest = {
  // What the user reads about the session that asks.
  label: string;
  // The tab that is asked for.
  title: string;
  url: string;
};

export type ConsentAnswer = 'allowed' | 'declined' | 'no_answer';

type Pending = ConsentRequest & { windowId: number | undefined; settle(answer: ConsentAnswer): void };

export class Consent {
  private _pending = new Map<string, Pending>();
  private _lastId = 0;

  constructor(listeners: ChromeListeners) {
    listeners.add(chrome.windows.onRemoved, windowId => {
      for (const pending of [...this._pending.values()]) {
        if (pending.windowId === windowId) {
          pending.settle('declined');
        }
      }
    });
  }

  async ask(request: ConsentRequest): Promise<ConsentAnswer> {
    const id = `${Date.now()}-${++this._lastId}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = new Promise<ConsentAnswer>(resolve => {
      const pending: Pending = {
        ...request,
        windowId: undefined,
        settle: given => {
          if (this._pending.delete(id)) {
            clearTimeout(timer);
            // The window can be closed already — that is how the user declined.
            if (pending.windowId !== undefined) {
              void chrome.windows.remove(pending.windowId).catch(() => {});
            }

            resolve(given);
          }
        },
      };

      this._pending.set(id, pending);
      timer = setTimeout(() => pending.settle('no_answer'), ANSWER_TIMEOUT_MS);
    });
    const pending = this._pending.get(id)!;

    try {
      const window = await chrome.windows.create({
        url: `${chrome.runtime.getURL('consent.html')}?id=${encodeURIComponent(id)}`,
        type: 'popup',
        width: 460,
        height: 320,
        focused: true,
      });

      pending.windowId = window?.id;
    } catch (error) {
      pending.settle('no_answer');

      throw error;
    }

    return await answer;
  }

  // What the page of the window shows; undefined once the request is over.
  describe(id: string): ConsentRequest | undefined {
    const pending = this._pending.get(id);

    return pending && { label: pending.label, title: pending.title, url: pending.url };
  }

  answer(id: string, allow: boolean): void {
    this._pending.get(id)?.settle(allow ? 'allowed' : 'declined');
  }

  // The sessions are gone: nobody waits for the answers.
  dismissAll(): void {
    for (const pending of [...this._pending.values()]) {
      pending.settle('no_answer');
    }
  }
}
