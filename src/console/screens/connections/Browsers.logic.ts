// The words and the choices of the Browsers section of the Connections
// screen, pure: the badge and the meta line of a browser, what the screen
// offers about the browser it is open in — by what the extension there
// answered and what the server lists — the words of a failed pairing, the
// check of a name and the name a new browser is offered.

import type { BrowserView, BrowsersResponse } from '../../../api/contract.ts';
import { compareVersions } from '../../../browser-link/protocol.ts';
import type { PairError } from '../../../browser-link/protocol.ts';
import type { ExtensionPresence } from '../../lib/extension/index.ts';
import { agoLabel } from '../../lib/format/index.ts';
import type { StateName } from '../../ui/atoms/atoms.tsx';

export const BROWSER_NAME_MAX_LENGTH = 60;

export function browserStatusWords(online: boolean): { state: StateName; label: string } {
  return online ? { state: 'done', label: 'online' } : { state: 'off', label: 'offline' };
}

// The line under a browser of the user: what sets it apart, then when it
// was last on the link if it is not there now.
export function browserMeta(browser: BrowserView, isThisBrowser: boolean, now: Date): string {
  return [
    isThisBrowser ? 'this browser' : null,
    browser.enabledHere ? null : 'not enabled in this workspace',
    browser.extensionVersion ? `extension ${browser.extensionVersion}${browser.outdated ? ' (outdated)' : ''}` : null,
    browser.online ? null : browser.lastSeenAt ? `last online ${agoLabel(browser.lastSeenAt, now)}` : 'never online',
  ]
    .filter(Boolean)
    .join(' · ');
}

// The record the extension of this browser is paired with, when it is one
// of the user's.
export function thisBrowser(presence: ExtensionPresence | null, listing: BrowsersResponse): BrowserView | null {
  const browserId = presence?.kind === 'present' ? presence.status.browserId : null;

  return (browserId && listing.browsers.find(browser => browser.id === browserId)) || null;
}

// What the screen offers about the browser it is open in:
// - nothing — not known yet, or the browser is connected and enabled here;
// - unsupported — not a desktop Chrome;
// - not-built — no extension here and the installation has none to give;
// - install — no extension here: download it and load it;
// - connect — the extension is here and paired with none of the user's
//   browsers;
// - enable — paired with a browser of the user that is not enabled in this
//   workspace;
// - paused — paired and enabled, but the extension holds no link.
export type ThisBrowserOffer =
  | { kind: 'nothing' | 'unsupported' | 'not-built' | 'install' | 'connect' }
  | { kind: 'enable' | 'paused'; browser: BrowserView };

export function thisBrowserOffer(presence: ExtensionPresence | null, listing: BrowsersResponse): ThisBrowserOffer {
  if (!presence) {
    return { kind: 'nothing' };
  }

  if (presence.kind === 'unsupported') {
    return { kind: 'unsupported' };
  }

  if (presence.kind === 'missing') {
    return { kind: listing.extension.version ? 'install' : 'not-built' };
  }

  const browser = thisBrowser(presence, listing);

  if (!browser) {
    return { kind: 'connect' };
  }

  if (!browser.enabledHere) {
    return { kind: 'enable', browser };
  }

  return presence.status.state === 'paused' ? { kind: 'paused', browser } : { kind: 'nothing' };
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

export function pairErrorWords(error: PairError): string {
  switch (error) {
    case 'code_rejected':
      return 'The server did not accept the pairing — the name may have been taken meanwhile. Try again.';
    case 'unsupported_protocol':
      return 'The extension in this browser is too old for this server. Download the current one, load it over the old one and try again.';
    default:
      return 'The extension did not reach the server. Check that it is enabled in this browser and try again.';
  }
}

export function validateBrowserName(name: string): string | null {
  return name.trim() ? null : 'Give the browser a name';
}

// "Chrome on Mac": enough to tell one's browsers apart, and editable.
export function defaultBrowserName(userAgent: string): string {
  const system = /Macintosh|Mac OS X/.test(userAgent) ? 'Mac' : /Windows/.test(userAgent) ? 'Windows' : /CrOS/.test(userAgent) ? 'Chromebook' : /Linux/.test(userAgent) ? 'Linux' : null;

  return system ? `Chrome on ${system}` : 'Chrome';
}
