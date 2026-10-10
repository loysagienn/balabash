// The element a fragment of the URL names inside a rendered document — the
// heading whose id (rehype-slug, MdRenderer) is the fragment's text. The
// browser's own reading: the fragment percent-decoded first, then as
// written when it does not decode or names nothing; an empty fragment
// names nothing. The lookup is scoped to the document's root, never the
// page — a heading "Root" must not find the app's own #root.

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
  const ids = fragmentIds(hash);

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
