// Where a relative reference of a Markdown document in the file area leads:
// the path it names, resolved against the document's folder, and the
// fragment it keeps. Only relative references resolve — a URL with a scheme
// (https:, mailto:), an absolute path (/files/…, //host/…), a fragment alone
// (#section) and an empty one are left to the renderer as they are. `..`
// above the file area's root stops at the root, a trailing slash (a folder)
// is dropped, a query is not kept (paths of the file area have none) and the
// percent-encoding is undone — the result is a path of the file area, which
// the owner turns into a route or into the URL of the bytes, encoding it
// again. Pure, tested.

export type RelativeTarget = { path: string; hash: string };

// A scheme is a colon before any of / ? # — the reading of react-markdown's
// defaultUrlTransform; a path from the root or a fragment is not relative.
export function isRelativeUrl(url: string): boolean {
  if (url === '' || url.startsWith('/') || url.startsWith('#')) {
    return false;
  }

  const colon = url.indexOf(':');

  if (colon === -1) {
    return true;
  }

  const stop = url.search(/[/?#]/);

  return stop !== -1 && stop < colon;
}

export function resolveRelative(documentPath: string, url: string): RelativeTarget | null {
  if (!isRelativeUrl(url)) {
    return null;
  }

  const folder = documentPath.slice(0, documentPath.lastIndexOf('/') + 1);

  try {
    const resolved = new URL(url, `file:///${folder}`);
    const path = decodeURIComponent(resolved.pathname).replace(/^\/+|\/+$/g, '');

    return { path, hash: resolved.hash };
  } catch {
    // A percent-encoding the URL carries but no path can hold.
    return null;
  }
}
