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

// A refusal about the slug shows under the field; anything else — the
// manifest, the path — is the form's own line. Known by the server's own
// wording (src/apps/management.ts): the slug rule, a reserved name, a taken
// slug, an app already published — not by the word "slug" anywhere in the
// message, which the folder's path or the manifest's details may carry.
const SLUG_REFUSALS = [/^slug must be /, /^"[a-z0-9-]*" is a reserved name/, /^the slug "[^"]*" is taken/, /^already published as /];

export function publishFailureUnderField(message: string): boolean {
  const text = message.toLowerCase();

  return SLUG_REFUSALS.some(pattern => pattern.test(text));
}

// The publication dialogs the row's menu offers and shows: "Publish…" to an
// unpublished row, "Unpublish…" to a published one. A dialog is shown only
// while its offer stands — once the row's publication changed (the call's
// answer, the tail's app.* from another tab or an agent, a listing), the
// dialog is over, whatever instance of it was on the screen; the menu
// forgets the choice, so the publication changing back does not bring the
// dialog back by itself.
export type PublicationDialog = 'publish' | 'unpublish' | null;

export function publicationDialog(chosen: PublicationDialog, published: boolean): PublicationDialog {
  if (chosen === 'publish') {
    return published ? null : 'publish';
  }

  if (chosen === 'unpublish') {
    return published ? 'unpublish' : null;
  }

  return null;
}

export function unpublishWords(address: string): string {
  return `The link ${address} will stop working, and the URL becomes free for any app.`;
}
