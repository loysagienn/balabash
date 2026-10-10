// Where a mini-app row leads (Home, the Apps section). A published app has
// an address (publicAppsBase + slug) — the chip shows it, and the app opens
// there while the manifest is valid; a broken manifest keeps the address
// (the publication stands) but answers 503 there, so the row has no "Open"
// to the public app (href null). Every app has its owner page, /apps/<path>
// on this very host: the console host passes it through to the handoff of
// the apps domain (src/api/console.ts, src/apps/handoff.ts) — the
// operator's own view of the app, published or not, and the page that
// shows the manifest error of a broken one. The chip text is the address
// without the scheme.

import type { AppListingView } from '../../../api/contract.ts';

export type AppLink = {
  // The public address of a published app.
  address: string | null;
  // The public app, when it opens there (published, valid manifest).
  href: string | null;
  // The owner page of the app on this host.
  owner: string;
  // Where "Open" leads: the public app when it opens there, the owner page
  // of an unpublished app with a valid manifest, nothing for a broken one
  // (its red line is the news; the owner page stays in the menu).
  open: string | null;
};

export function ownerAppHref(path: string): string {
  return `/apps/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function publicAppAddress(base: string, slug: string): string {
  return `${base}/${encodeURIComponent(slug)}`;
}

export function appLink(app: Pick<AppListingView, 'path' | 'slug' | 'manifestError'>, base: string): AppLink {
  const address = app.slug ? publicAppAddress(base, app.slug) : null;
  const valid = app.manifestError === null;
  const href = address !== null && valid ? address : null;
  const owner = ownerAppHref(app.path);

  return { address, href, owner, open: href ?? (valid ? owner : null) };
}

export function appUrlText(href: string): string {
  return href.replace(/^https?:\/\//, '');
}

// The name shown for an app: the manifest's, or the last segment of its
// folder when the manifest has none (or is broken).
export function appTitle(app: Pick<AppListingView, 'name' | 'path'>): string {
  return app.name ?? app.path.split('/').pop() ?? app.path;
}
