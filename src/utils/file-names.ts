// Two facts of uploads shared by the core and the console (an isolated
// runtime module — no node, no DOM): the size limit of one uploaded file and
// the name a file takes beside another of the same name.

// The largest file an upload accepts — to the file area and to storage
// alike: the ceiling of files.size_bytes (a 32-bit Int), one byte short of
// 2 GiB. The proxy in front lets 2 GiB through; the app is the one to refuse.
export const UPLOAD_MAX_BYTES = 2 ** 31 - 1;

// The name of the n-th file of one name in a folder: n = 1 is the name
// itself, n ≥ 2 — "name (n).ext", the number before the last extension
// ("report (2).pdf", "archive.tar (2).gz"); a name without an extension or
// one that is only an extension (".env") takes the number at its end. The
// path's folder stays as it is: only the last segment is numbered.
export function numberedName(path: string, n: number): string {
  if (n <= 1) {
    return path;
  }

  const slash = path.lastIndexOf('/');
  const folder = slash === -1 ? '' : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];

  return `${folder}${base} (${n})${extension}`;
}

// The first numbered name not among the taken ones (n ≥ 2): what "Keep both"
// gives a clashing file, as far as the caller knows the folder.
export function freeNumberedName(path: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n += 1) {
    const candidate = numberedName(path, n);

    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
