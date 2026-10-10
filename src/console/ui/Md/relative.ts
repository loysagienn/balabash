// Where a relative reference of a Markdown document in the file area leads:
// the path it names, resolved against the document, and the fragment it
// keeps. Only relative references resolve — a URL with a scheme (https:,
// mailto:), an absolute path (/files/…, //host/…, \\host\…), a fragment
// alone (#section) and an empty one are left to the renderer as they are.
// The document's own path is encoded segment by segment before it serves as
// the base, so `#`, `?` and `%` in a folder's name stay the name's; a
// reference of a query alone leads to the document itself. `..` above the
// file area's root stops at the root, a trailing slash (a folder) is
// dropped, a query is not kept (paths of the file area have none) and the
// percent-encoding is undone, one segment at a time — a segment that then
// holds a separator (%2F, %5C: the server reads a backslash as one), or is
// empty, cannot be a path of the file area and resolves to nothing, the
// way a broken percent-escape does. The result is a path of the file area,
// which the owner turns into a route or into the URL of the bytes, encoding
// it again. Pure, tested.

export type RelativeTarget = { path: string; hash: string };

// A scheme is a colon before any of / ? # — the reading of react-markdown's
// defaultUrlTransform; a path from the root (the URL parser reads a leading
// backslash as a slash too) or a fragment is not relative.
export function isRelativeUrl(url: string): boolean {
  if (url === '' || url.startsWith('/') || url.startsWith('\\') || url.startsWith('#')) {
    return false;
  }

  const colon = url.indexOf(':');

  if (colon === -1) {
    return true;
  }

  const stop = url.search(/[/?#]/);

  return stop !== -1 && stop < colon;
}

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

// A decoded segment the file area can hold: no separator either way, not
// empty, not a dot segment (the parser folds the plain ones; these come
// only out of an encoded separator).
const isSegment = (segment: string): boolean => segment !== '' && segment !== '.' && segment !== '..' && !segment.includes('/') && !segment.includes('\\');

export function resolveRelative(documentPath: string, url: string): RelativeTarget | null {
  if (!isRelativeUrl(url)) {
    return null;
  }

  try {
    const resolved = new URL(url, `file:///${encodePath(documentPath)}`);

    if (resolved.host !== '') {
      return null;
    }

    const segments = resolved.pathname.split('/').slice(1).map(decodeURIComponent);

    // The trailing slash of a folder; the root is '/' — one empty segment.
    if (segments[segments.length - 1] === '') {
      segments.pop();
    }

    if (!segments.every(isSegment)) {
      return null;
    }

    return { path: segments.join('/'), hash: resolved.hash };
  } catch {
    // A percent-encoding the URL carries but no path can hold.
    return null;
  }
}
