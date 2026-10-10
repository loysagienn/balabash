// The ids of a rendered document's headings, and the element a fragment of
// the URL names among them.
//
// A heading's id is HEADING_ID_PREFIX + the GitHub slug of its text
// (rehype-slug with HEADING_IDS, MdRenderer). The prefix is GitHub's own
// `user-content-`, and for GitHub's reason: a document is the user's text,
// and the page has ids of its own — `edit-project` is the form of "Edit
// project" (a Save button with form="edit-project" follows the FIRST
// element of that id in the document, and a heading in its place would
// leave the button without a form), `root` is the app's root, every field
// has one for its label. Without the prefix, a heading "Edit project" on
// the project page — the dialog is a portal after the app's tree — takes
// the id first. The prefix is the same for every heading, so the ids of a
// document stay as unique as the slugs (two "A" are user-content-a and
// user-content-a-1) and can never equal an id of the interface, which
// holds no `user-content-` id — a reservation ui.md records. The fragment
// of a URL stays the slug, as GitHub writes it: `#anchors` names the
// heading user-content-anchors.
//
// fragmentIds is the browser's own reading of a fragment: percent-decoded
// first, then as written when it does not decode or names nothing; an
// empty fragment names nothing. fragmentTarget looks only inside the
// document's root, never the page, and only for a heading's id — the
// interface's own `#root` is not a section of a document.

import type { Options as SlugOptions } from 'rehype-slug';

export const HEADING_ID_PREFIX = 'user-content-';

// The options of rehype-slug for a placed document (MdRenderer).
export const HEADING_IDS: SlugOptions = { prefix: HEADING_ID_PREFIX };

// The id of the heading whose slug is `slug`.
export const headingId = (slug: string): string => HEADING_ID_PREFIX + slug;

export function fragmentIds(hash: string): string[] {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;

  if (raw === '') {
    return [];
  }

  try {
    const decoded = decodeURIComponent(raw);

    return decoded === raw ? [raw] : [decoded, raw];
  } catch {
    return [raw];
  }
}

export function fragmentTarget(root: ParentNode, hash: string): HTMLElement | null {
  const ids = fragmentIds(hash).map(headingId);

  if (ids.length === 0) {
    return null;
  }

  const candidates = Array.from(root.querySelectorAll<HTMLElement>('[id]'));

  for (const id of ids) {
    const found = candidates.find(element => element.id === id);

    if (found) {
      return found;
    }
  }

  return null;
}
