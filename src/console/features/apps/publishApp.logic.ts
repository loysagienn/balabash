// The rules of the "Publish" dialog of an app: the slug suggested from the
// app's name, the checks the server makes (src/apps/management.ts — the
// slug rule and the reserved names are the server's law, repeated here so a
// mistake shows under the field before the call), a slug another app of
// this workspace already holds (the server would refuse it too, without
// saying whose it is — the console knows its own rows), which refusal of
// the server belongs to the field, the words of the unpublish question.
// Pure, tested.

import type { AppListingView } from '../../../api/contract.ts';
import { appTitle } from '../../lib/apps/appLink.ts';
import { capSlug, slugWords } from '../../lib/text/slug.ts';

export const APP_SLUG_MAX_LENGTH = 64;
// The server's rule: 1–64 of [a-z0-9-], not starting or ending with a dash.
export const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
// The path branches of the apps domain a slug must never shadow.
export const RESERVED_APP_SLUGS = ['apps', 'auth', 'platform'];

// The slug the server would store for what the operator typed.
export function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

// "Renovation checklist" at renovation/app → "renovation-checklist"; an app
// without a name — the words of its folder's last segment.
export function suggestedSlug(app: Pick<AppListingView, 'name' | 'path'>): string {
  const words = slugWords(app.name ?? '') || slugWords(app.path.split('/').pop() ?? '');

  return capSlug(words, APP_SLUG_MAX_LENGTH);
}

export function slugError(slug: string): string | null {
  if (!slug) {
    return 'A URL is required.';
  }

  if (!APP_SLUG_PATTERN.test(slug)) {
    return 'Lowercase letters, digits and dashes, up to 64 characters, not starting or ending with a dash.';
  }

  if (RESERVED_APP_SLUGS.includes(slug)) {
    return `“${slug}” is a reserved name — pick another URL.`;
  }

  return null;
}

// Another app of this workspace published under the slug, if any.
export function slugTakenBy<A extends Pick<AppListingView, 'path' | 'slug'>>(apps: A[], slug: string, path: string): A | null {
  return apps.find(app => app.slug === slug && app.path !== path) ?? null;
}

export function takenWords(app: Pick<AppListingView, 'name' | 'path'>): string {
  return `URL already taken by “${appTitle(app)}”`;
}

// A refusal about the slug shows under the field ("slug must be…", "the
// slug "x" is taken", "already published as…"); anything else — the manifest,
// the path — is the form's own line.
export function publishFailureUnderField(message: string): boolean {
  const text = message.toLowerCase();

  return text.includes('slug') || text.includes('already published');
}

export function unpublishWords(address: string): string {
  return `The link ${address} will stop working, and the URL becomes free for any app.`;
}
