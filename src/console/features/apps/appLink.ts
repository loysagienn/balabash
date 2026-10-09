// Where a mini-app row leads (Home, the Apps section). A published app has
// an address (publicAppsBase + slug) — the chip shows it, and the app opens
// there while the manifest is valid; a broken manifest keeps the address
// (the publication stands) but answers 503 there, so the row has no "Open"
// and leads to the Apps section instead (href null). The chip text is the
// address without the scheme.

import type { AppListingView } from '../../../api/contract.ts';

export type AppLink = { address: string | null; href: string | null };

export function appLink(app: Pick<AppListingView, 'slug' | 'manifestError'>, base: string): AppLink {
  const address = app.slug ? `${base}/${encodeURIComponent(app.slug)}` : null;

  return { address, href: address !== null && app.manifestError === null ? address : null };
}

export function appUrlText(href: string): string {
  return href.replace(/^https?:\/\//, '');
}

// The name shown for an app: the manifest's, or the last segment of its
// folder when the manifest has none (or is broken).
export function appTitle(app: Pick<AppListingView, 'name' | 'path'>): string {
  return app.name ?? app.path.split('/').pop() ?? app.path;
}
