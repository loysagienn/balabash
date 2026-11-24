// The words and the choices of the Browsers card of the Connections screen,
// pure: the panel about the browser the console is open in — by what the
// extension there answered and what the server lists — the update of its
// extension, the badge and the lines of a row, which rows changed between
// two reads of the list, the words of a refused pairing or name, and the
// name a new browser is offered.

import type { BrowserView, BrowsersResponse, OtherBrowserView } from '../../../api/contract.ts';
import { compareVersions } from '../../../browser-link/protocol.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { ExtensionPresence, PairFailure } from '../../lib/extension/index.ts';
import { agoLabel, fileSize } from '../../lib/format/index.ts';
import type { StateName } from '../../ui/atoms/state.ts';

export const BROWSER_NAME_MAX_LENGTH = 60;

// The record the extension of this browser is paired with, when it is one
// of the user's.
export function thisBrowser(presence: ExtensionPresence | null, listing: BrowsersResponse): BrowserView | null {
  const browserId = presence?.kind === 'present' ? presence.status.browserId : null;

  return (browserId && listing.browsers.find(browser => browser.id === browserId)) || null;
}

// The extension of this browser is on pause: it holds no link by the user's
// own word.
export function isPausedHere(presence: ExtensionPresence | null): boolean {
  return presence?.kind === 'present' && presence.status.state === 'paused';
}

// The panel about the browser the console is open in — its state and the
// next step:
// - none — the browser is connected and on in this workspace: its row says
//   "this browser";
// - checking — the extension has not answered yet;
// - not-chrome — not a desktop Chrome: a browser is connected from itself;
// - no-build — no extension here and the installation has none to give;
// - no-ext — no extension here: the steps of an installation;
// - unpaired — the extension is here (its version) and paired with none of
//   the user's browsers: a name and "Connect this browser";
// - off-here — paired with a browser of the user that is off in this
//   workspace;
// - paused — paired and on here, but the extension holds no link.
export type HerePanel =
  | { kind: 'none' | 'checking' | 'not-chrome' | 'no-build' | 'no-ext' }
  | { kind: 'unpaired'; version: string }
  | { kind: 'off-here' | 'paused'; browser: BrowserView };

export function herePanel(presence: ExtensionPresence | null, listing: BrowsersResponse): HerePanel {
  if (!presence) {
    return { kind: 'checking' };
  }

  if (presence.kind === 'unsupported') {
    return { kind: 'not-chrome' };
  }

  if (presence.kind === 'missing') {
    return { kind: listing.extension.version ? 'no-ext' : 'no-build' };
  }

  const browser = thisBrowser(presence, listing);

  if (!browser) {
    return { kind: 'unpaired', version: presence.status.version };
  }

  if (!browser.enabledHere) {
    return { kind: 'off-here', browser };
  }

  return isPausedHere(presence) ? { kind: 'paused', browser } : { kind: 'none' };
}

// The extension of this browser is older than the one the installation
// hands out: the two versions; null when it is not, or nothing is known.
export function extensionUpdate(presence: ExtensionPresence | null, listing: BrowsersResponse): { installed: string; current: string } | null {
  const current = listing.extension.version;

  if (presence?.kind !== 'present' || !current || compareVersions(presence.status.version, current) >= 0) {
    return null;
  }

  return { installed: presence.status.version, current };
}

// "balabash-agent-0.7.0.zip · 212 KiB": the archive the installation hands out.
export function archiveLabel(extension: BrowsersResponse['extension']): string {
  return [`balabash-agent-${extension.version ?? ''}.zip`, extension.size === null ? null : fileSize(extension.size)].filter(Boolean).join(' · ');
}

// The badge of a browser: on the link or not — and, for the browser the
// console is open in, that its extension is on pause.
export function browserBadge(online: boolean, pausedHere = false): { state: StateName; label: string } {
  if (pausedHere) {
    return { state: 'off', label: 'paused' };
  }

  return online ? { state: 'done', label: 'online' } : { state: 'off', label: 'offline' };
}

function lastSeen(lastSeenAt: Date | null, now: Date): string {
  return lastSeenAt ? `last seen ${agoLabel(lastSeenAt, now)}` : 'never online';
}

// The line under a browser of the user: when it was last on the link if it
// is not there now (the browser the console is open in needs no such word),
// its extension, and that it is off in this workspace. `on` — as the row's
// switch shows it.
export function browserMeta(browser: BrowserView, options: { here: boolean; on: boolean; workspace: string; now: Date }): string {
  return [
    browser.online || options.here ? null : lastSeen(browser.lastSeenAt, options.now),
    browser.extensionVersion ? `extension ${browser.extensionVersion}` : null,
    options.on ? null : `off in ${options.workspace}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

// The amber line of a browser whose extension is out of date; null when it
// is not, or the installation has none to compare with.
export function outdatedLine(browser: BrowserView, here: boolean, current: string | null): string | null {
  if (!browser.outdated || !current) {
    return null;
  }

  return here ? `Out of date — ${current} is on the server.` : `Out of date — update it on that computer to ${current}.`;
}

export function otherOwner(browser: OtherBrowserView): string {
  return browser.ownerName?.trim() || 'another member';
}

// A browser of another member: whose it is in the title and in the line
// under it, with when it was last on the link if it is not there now.
export function otherWords(browser: OtherBrowserView, now: Date): { title: string; meta: string } {
  const owner = otherOwner(browser);

  return {
    title: browser.ownerName?.trim() ? `${owner} · ${browser.name}` : browser.name,
    meta: [`owned by ${owner}`, browser.online ? null : lastSeen(browser.lastSeenAt, now)].filter(Boolean).join(' · '),
  };
}

// What a row shows that a change of is worth a flash: per row id.
export function rowSignatures(listing: BrowsersResponse): Map<string, string> {
  return new Map<string, string>([
    ...listing.browsers.map(browser => [browser.id, JSON.stringify([browser.name, browser.online, browser.enabledHere])] as const),
    ...listing.others.map(browser => [browser.id, JSON.stringify([browser.name, browser.ownerName, browser.online])] as const),
  ]);
}

// The rows that came or changed since the last read of the list; none at
// the first read — nothing was there to change.
export function changedRows(known: Map<string, string> | null, now: Map<string, string>): string[] {
  if (!known) {
    return [];
  }

  return [...now].filter(([id, signature]) => known.get(id) !== signature).map(([id]) => id);
}

// A name the user or the server refuses, under the field: the dialog's own
// check before the call, and the two refusals of the server by their code.
// Null — the name passes, or the failure is not about the name.
export function nameError(name: string): string | null {
  const clean = name.trim();

  return clean && clean.length <= BROWSER_NAME_MAX_LENGTH ? null : 'Give it a name, up to 60 characters.';
}

export function nameRefusal(name: string, failure: ApiFailure): string | null {
  if (failure.code === 'name_taken') {
    return `You already have a browser named “${name.trim()}”.`;
  }

  return failure.code === 'invalid_name' ? 'Give it a name, up to 60 characters.' : null;
}

// The server did not issue a pairing code, and not because of the name.
export function pairingRefusedWords(failure: ApiFailure): string {
  return failure.status === 0 ? 'The server didn’t answer. Try again.' : `The server didn’t accept the connection (HTTP ${failure.status}). Try again.`;
}

// The pairing did not happen in the extension.
export function pairErrorWords(error: PairFailure): string {
  switch (error) {
    case 'code_rejected':
      return 'The server didn’t accept the connection. Try again.';
    case 'unsupported_protocol':
      return 'This extension is too old for the server. Update it with the panel above, then connect.';
    case 'unreachable':
      return 'The extension couldn’t reach the server. Check that this computer is online, then try again.';
    case 'no_answer':
      return 'The extension didn’t answer. Reload it on chrome://extensions and try again.';
  }
}

// Why the list was not read, under "Couldn’t load browsers".
export function loadFailedWords(failure: ApiFailure): string {
  const what = failure.status === 0 ? 'No answer from the server.' : `HTTP ${failure.status} · ${failure.code}.`;

  return `${what} Your browsers keep working; this page just can’t show them.`;
}

// "Chrome on Mac": enough to tell one's browsers apart, and editable.
export function defaultBrowserName(userAgent: string): string {
  const system = /Macintosh|Mac OS X/.test(userAgent) ? 'Mac' : /Windows/.test(userAgent) ? 'Windows' : /CrOS/.test(userAgent) ? 'Chromebook' : /Linux/.test(userAgent) ? 'Linux' : null;

  return system ? `Chrome on ${system}` : 'Chrome';
}
