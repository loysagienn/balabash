// The user's word on handing a tab to a session: a small window of the
// extension (consent.html) that says which session asks and for which tab,
// with Allow and Deny. Closing the window is a refusal; a minute without
// an answer is "no answer", and the window closes itself. The page of the
// window talks to the worker (background.ts) — it learns what is asked and
// brings the answer; an answer counts only from the window the question was
// asked in. A question belongs to the session that asked: it is over when
// the session is — the window stays to say so, with nothing left to decide.

import type { ChromeListeners } from './playwright/chromeListeners';

const ANSWER_TIMEOUT_MS = 60_000;

export type ConsentRequest = {
  // Who asks: the workspace ('' — it has no name) and the agent's thread.
  workspace: string;
  thread: string;
  // The tab that is asked for.
  title: string;
  url: string;
};

// The request as its window shows it: with the moment the minute runs out.
export type ConsentView = ConsentRequest & { askedAt: number; expiresAt: number };

export type ConsentAnswer = 'allowed' | 'declined' | 'no_answer';

type Pending = ConsentView & {
  // Who asked.
  owner: unknown;
  windowId: number | undefined;
  // Settles once the window is there, or was not made.
  opened: Promise<unknown>;
  // `keepWindow` — the window stays open to say that the request is over.
  settle(answer: ConsentAnswer, keepWindow?: boolean): void;
};

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

  // `owner` — the session that asks (dismiss).
  async ask(request: ConsentRequest, owner: unknown): Promise<ConsentAnswer> {
    const id = `${Date.now()}-${++this._lastId}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const askedAt = Date.now();
    const answer = new Promise<ConsentAnswer>(resolve => {
      const pending: Pending = {
        ...request,
        askedAt,
        expiresAt: askedAt + ANSWER_TIMEOUT_MS,
        owner,
        windowId: undefined,
        opened: Promise.resolve(),
        settle: (given, keepWindow) => {
          if (this._pending.delete(id)) {
            clearTimeout(timer);
            // The window can be closed already — that is how the user declined.
            if (pending.windowId !== undefined && !keepWindow) {
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
      const creating = chrome.windows.create({
        url: `${chrome.runtime.getURL('consent.html')}?id=${encodeURIComponent(id)}`,
        type: 'popup',
        // The page fits the window to what it shows (consent-page.tsx).
        width: 416,
        height: 520,
        focused: true,
      });

      pending.opened = creating.catch(() => {});
      pending.windowId = (await creating)?.id;
    } catch (error) {
      pending.settle('no_answer');

      throw error;
    }

    return await answer;
  }

  // What the page of the window shows; undefined once the request is over.
  describe(id: string): ConsentView | undefined {
    const pending = this._pending.get(id);

    return (
      pending && {
        workspace: pending.workspace,
        thread: pending.thread,
        title: pending.title,
        url: pending.url,
        askedAt: pending.askedAt,
        expiresAt: pending.expiresAt,
      }
    );
  }

  // `windowId` — the window the answer came from: it counts only from the
  // window of the question.
  async answer(id: string, allow: boolean, windowId: number | undefined): Promise<void> {
    const pending = this._pending.get(id);

    await pending?.opened;

    if (pending && pending.windowId !== undefined && pending.windowId === windowId) {
      pending.settle(allow ? 'allowed' : 'declined');
    }
  }

  // The session that asked is gone: nobody waits for its answers.
  dismiss(owner: unknown): void {
    for (const pending of [...this._pending.values()]) {
      if (pending.owner === owner) {
        pending.settle('no_answer', true);
      }
    }
  }

  // The sessions are gone: nobody waits for the answers.
  dismissAll(): void {
    for (const pending of [...this._pending.values()]) {
      pending.settle('no_answer', true);
    }
  }
}
