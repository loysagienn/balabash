// The Balabash Agent extension of the browser this console is open in
// (src/browser-extension), as a page reaches it:
// `chrome.runtime.sendMessage(<extension id>, …)` — the extension's manifest
// names the console's origin as one that may. Chrome gives a page
// `chrome.runtime` only while an extension that lets the page talk to it is
// installed, so its absence says "no extension" — and a page that was open
// when the extension was installed has to be loaded again to get it.
//
// What the extension is asked: its status, to pair with a code the server
// issued, and to take the color theme the user chose in the console — the
// extension draws its own pages in it (src/browser-link/protocol.ts). Every
// question has a deadline: a disabled extension leaves the message
// unanswered.

import { EXTENSION_ID } from '../../../browser-link/protocol.ts';
import type { PagePairResult, PageRequest, PageStatus, PairError } from '../../../browser-link/protocol.ts';
import type { ThemeId } from '../../../utils/console-themes.ts';
import { readTheme, subscribeTheme } from '../theme/index.ts';

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

// Whether this page can send the extension anything at all. A page that was
// open when the extension was installed cannot until it is loaded again.
export function canReachExtension(win: ExtensionWindow = window): boolean {
  return typeof win.chrome?.runtime?.sendMessage === 'function';
}

// Why a pairing did not happen, as the page learns it: what the extension
// said (PairError) — or that the extension said nothing (`no_answer`: it was
// disabled or reloaded meanwhile, or took longer than the deadline).
export type PairFailure = PairError | 'no_answer';

export type PairOutcome = { ok: true; browserId: string } | { ok: false; error: PairFailure };

// Hands the pairing code to the extension; it dials the server with it.
export async function pairExtension(extensionId: string, code: string, win: ExtensionWindow = window): Promise<PairOutcome> {
  try {
    const answer = (await ask(win, extensionId, { type: 'pair', code }, PAIR_TIMEOUT_MS)) as PagePairResult | null | undefined;

    return answer && typeof answer.ok === 'boolean' ? answer : { ok: false, error: 'no_answer' };
  } catch {
    return { ok: false, error: 'no_answer' };
  }
}

// Tells the extension of this browser the theme of the console. Nobody
// waits for the answer: no extension, an older one that knows no such
// message, a disabled one — all the same silence.
export function tellExtensionTheme(theme: ThemeId, win: ExtensionWindow = window, extensionId: string = EXTENSION_ID): void {
  if (!supportsExtension(win) || !canReachExtension(win)) {
    return;
  }

  try {
    void ask(win, extensionId, { type: 'theme', theme }, STATUS_TIMEOUT_MS)?.catch(() => {});
  } catch {
    // Chrome throws when the id names no extension that lets this page in.
  }
}

// At boot, on any screen: the extension learns the theme the console is in,
// and every change of it — this tab's choice or another tab's (lib/theme).
export function connectExtensionToTheme(win: Window = window): () => void {
  const tell = () => tellExtensionTheme(readTheme(), win as unknown as ExtensionWindow);

  tell();

  return subscribeTheme(tell);
}
