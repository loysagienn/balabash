// The Balabash Agent extension of the browser this console is open in
// (src/browser-extension), as a page reaches it:
// `chrome.runtime.sendMessage(<extension id>, …)` — the extension's manifest
// names the console's origin as one that may. Chrome gives a page
// `chrome.runtime` only while an extension that lets the page talk to it is
// installed, so its absence says "no extension" — and a page that was open
// when the extension was installed has to be loaded again to get it.
//
// What the extension is asked: its status, and to pair with a code the
// server issued (src/browser-link/protocol.ts). Every question has a
// deadline: a disabled extension leaves the message unanswered.

import type { PagePairResult, PageRequest, PageStatus } from '../../../browser-link/protocol.ts';

const STATUS_TIMEOUT_MS = 3000;
// A pairing dials the server and waits for its answer.
const PAIR_TIMEOUT_MS = 30_000;

// What this browser can say about the extension:
// - unsupported — not a desktop Chrome: no extension can be here;
// - missing — Chrome without the extension (or with it disabled, or
//   installed after this page was loaded);
// - otherwise what the extension answered.
export type ExtensionPresence = { kind: 'unsupported' } | { kind: 'missing' } | { kind: 'present'; status: PageStatus };

export type ExtensionWindow = {
  chrome?: { runtime?: { sendMessage?: (extensionId: string, message: unknown) => Promise<unknown> } };
  navigator: { userAgent: string };
};

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The extension did not answer')), ms);

    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function ask(win: ExtensionWindow, extensionId: string, message: PageRequest, ms: number): Promise<unknown> | null {
  const send = win.chrome?.runtime?.sendMessage;

  return send ? withDeadline(Promise.resolve().then(() => send(extensionId, message)), ms) : null;
}

function isStatus(value: unknown): value is PageStatus {
  const status = value as Partial<PageStatus> | null;

  return typeof status?.version === 'string' && typeof status.state === 'string';
}

// A desktop Chrome (or a browser built on it): the only place the extension
// lives. Chrome on a phone has `chrome` too, and no extensions.
export function supportsExtension(win: ExtensionWindow): boolean {
  return win.chrome !== undefined && !/Android|iPhone|iPad|Mobile/i.test(win.navigator.userAgent);
}

export async function extensionPresence(extensionId: string, win: ExtensionWindow = window): Promise<ExtensionPresence> {
  if (!supportsExtension(win)) {
    return { kind: 'unsupported' };
  }

  try {
    const answer = await ask(win, extensionId, { type: 'status' }, STATUS_TIMEOUT_MS);

    return isStatus(answer) ? { kind: 'present', status: answer } : { kind: 'missing' };
  } catch {
    return { kind: 'missing' };
  }
}

// Hands the pairing code to the extension; it dials the server with it.
export async function pairExtension(extensionId: string, code: string, win: ExtensionWindow = window): Promise<PagePairResult> {
  try {
    const answer = (await ask(win, extensionId, { type: 'pair', code }, PAIR_TIMEOUT_MS)) as PagePairResult | null | undefined;

    return answer && typeof answer.ok === 'boolean' ? answer : { ok: false, error: 'unreachable' };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
}
