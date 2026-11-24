// What the extension's own pages share: asking the worker (background.ts),
// the start of a page — its theme, then React — and the small things both
// pages draw the same way.

import type { OwnPageAnswers, OwnPageRequest } from './background.ts';

// Undefined when the worker did not answer.
export function ask<R extends OwnPageRequest>(request: R): Promise<OwnPageAnswers[R['type']] | undefined> {
  return chrome.runtime.sendMessage(request).catch(() => undefined);
}

// The letter a tab is drawn with, where a site's icon would be.
export function tabLetter(title: string | undefined, url: string | undefined): string {
  const from = (title ?? '').trim() || hostOf(url);

  return (from.match(/[\p{L}\p{N}]/u)?.[0] ?? '·').toUpperCase();
}

export function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// An address as a line under a title: the host and the path apart, no
// scheme; a page without a host (chrome://, about:) as it is.
export function addressParts(url: string | undefined): { host: string; path: string } {
  try {
    const parsed = new URL(url ?? '');

    if (!/^https?:$/.test(parsed.protocol)) {
      return { host: (url ?? '').replace(/\/$/, ''), path: '' };
    }

    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;

    return { host: parsed.host.replace(/^www\./, ''), path: path === '/' ? '' : path };
  } catch {
    return { host: url ?? '', path: '' };
  }
}
