// A path "Files/balabash/design" → the clickable parts and the current one
// (design: Crumbs renderVals). Empty segments (a trailing slash, "//")
// are dropped.

export type CrumbsVals = { parts: string[]; current: string };

export function crumbsFromPath(path: string): CrumbsVals {
  const all = path.split('/').filter(Boolean);

  return { parts: all.slice(0, -1), current: all[all.length - 1] ?? '' };
}
