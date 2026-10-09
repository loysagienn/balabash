// The file area's pure rules: paths, what a file gets as a preview, the
// listing's footer. The node comes from GET /api/workspace/node
// (WorkspaceNodeResponse); the content of a text file is fetched from
// /files/<rel> only when a viewer reads it.

import type { WorkspaceFileMeta, WorkspaceNodeResponse } from '../../../api/contract.ts';
import { countOf, fileSize } from '../../lib/format/index.ts';

// Text larger than this is a download, not a preview (the design's "a 48 MB
// text file is too large to preview").
export const TEXT_PREVIEW_MAX = 2 * 1024 * 1024;
// Code larger than this is shown as plain lines: highlighting a huge file
// would stall the tab.
export const HIGHLIGHT_MAX = 256 * 1024;

export type Viewer =
  | { kind: 'markdown' }
  | { kind: 'code'; language: string | null }
  | { kind: 'csv'; delimiter: ',' | '\t' }
  | { kind: 'image' }
  | { kind: 'pdf' }
  // No preview: the type has none, or the text is too large.
  | { kind: 'none'; reason: 'type' | 'size' };

export function parentOf(path: string): string {
  const at = path.lastIndexOf('/');

  return at < 0 ? '' : path.slice(0, at);
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

// A dotfile (".env") counts its name as the extension.
export function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');

  return at < 0 ? '' : name.slice(at + 1).toLowerCase();
}

// The highlight.js grammar for an extension (ui/Md/languages.ts holds the
// curated set); null — plain text.
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonl: 'json',
  ndjson: 'json',
  css: 'css',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  diff: 'diff',
  patch: 'diff',
};

// Extensions of text files the content-type map of the server does not
// call text/* (the viewer reads them as text anyway).
const TEXT_EXT = new Set([
  'env', 'gitignore', 'toml', 'ini', 'cfg', 'conf', 'log', 'txt', 'err', 'out', 'prisma', 'lock',
  'go', 'rs', 'rb', 'php', 'java', 'c', 'h', 'cpp', 'hpp', 'scss', 'less', 'tex', 'bib', 'csv', 'tsv',
  'pyi', 'ipynb', 'map',
]);

function isTextType(mediaType: string, ext: string): boolean {
  return (
    mediaType.startsWith('text/') ||
    /^application\/(json|x-ndjson|yaml|toml|sql|xml|javascript|x-javascript|typescript|x-sh)$/.test(mediaType) ||
    ext in LANGUAGE_BY_EXT ||
    TEXT_EXT.has(ext)
  );
}

export function viewerFor(file: Pick<WorkspaceFileMeta, 'path' | 'sizeBytes' | 'mediaType'>): Viewer {
  const ext = extensionOf(nameOf(file.path));
  const type = file.mediaType.toLowerCase();

  if (type.startsWith('image/')) {
    return { kind: 'image' };
  }
  if (type === 'application/pdf') {
    return { kind: 'pdf' };
  }
  if (!isTextType(type, ext)) {
    return { kind: 'none', reason: 'type' };
  }
  if ((file.sizeBytes ?? 0) > TEXT_PREVIEW_MAX) {
    return { kind: 'none', reason: 'size' };
  }
  if (ext === 'md' || ext === 'markdown') {
    return { kind: 'markdown' };
  }
  if (ext === 'csv' || ext === 'tsv') {
    return { kind: 'csv', delimiter: ext === 'tsv' ? '\t' : ',' };
  }

  return { kind: 'code', language: LANGUAGE_BY_EXT[ext] ?? null };
}

export type DirListing = Extract<WorkspaceNodeResponse, { kind: 'dir' }>;

// "2 folders · 6 files · 307 KiB" — the footer of a listing; a size only
// when a file has one.
export function listingSummary(listing: Pick<DirListing, 'directories' | 'files'>): string {
  const parts = [countOf(listing.directories.length, 'folder'), countOf(listing.files.length, 'file')];
  const bytes = listing.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);

  if (bytes > 0) {
    parts.push(fileSize(bytes));
  }

  return parts.join(' · ');
}

// The parts of the breadcrumbs: the path below the root, split into
// segments; the last one is current.
export function crumbSegments(root: string, path: string): string[] {
  const below = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path === root ? '' : path;

  return below.split('/').filter(Boolean);
}

export function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}
