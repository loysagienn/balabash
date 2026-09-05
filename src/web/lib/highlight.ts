// Syntax highlighting shared by the workspace viewers: one curated set of
// highlight.js grammars feeds both the code viewer (via lowlight) and the
// fenced blocks of the markdown viewer (via rehype-highlight), so a single
// CSS theme (.hl in workspace.module.css) covers everything. Grammars are
// registered explicitly — the full highlight.js set is ~190 languages and
// would bloat the client bundle for nothing.

import type { LanguageFn } from 'lowlight';
import { createLowlight } from 'lowlight';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import type { ReactNode } from 'react';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import graphql from 'highlight.js/lib/languages/graphql';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import protobuf from 'highlight.js/lib/languages/protobuf';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

export const languages: Record<string, LanguageFn> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  kotlin,
  less,
  lua,
  makefile,
  markdown,
  php,
  plaintext,
  protobuf,
  python,
  r,
  ruby,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

// Aliases on top of what the grammars declare themselves (js/jsx/mjs, ts/tsx,
// py, yml, sh/zsh, html/svg, toml… are already built in). Used for fenced
// block info strings in markdown; the code viewer resolves canonical names.
export const aliases: Record<string, string[]> = {
  ini: ['env', 'dotenv', 'cfg', 'conf', 'properties'],
  json: ['jsonc', 'json5', 'jsonl', 'ndjson'],
  plaintext: ['log', 'csv', 'tsv'],
  markdown: ['mdx'],
  shell: ['console', 'shellsession'],
};

export const lowlight = createLowlight(languages);

lowlight.registerAlias(aliases);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  pyi: 'python',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  jsonl: 'json',
  ndjson: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  properties: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  html: 'xml',
  htm: 'xml',
  xhtml: 'xml',
  xml: 'xml',
  svg: 'xml',
  xsl: 'xml',
  xsd: 'xml',
  plist: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  diff: 'diff',
  patch: 'diff',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  lua: 'lua',
  r: 'r',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  dockerfile: 'dockerfile',
  mk: 'makefile',
  txt: 'plaintext',
  text: 'plaintext',
  log: 'plaintext',
  csv: 'plaintext',
  tsv: 'plaintext',
};

// Extension-less files that are text by convention.
const LANGUAGE_BY_BASENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.env': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.gitattributes': 'plaintext',
  '.gitignore': 'plaintext',
  '.dockerignore': 'plaintext',
  '.prettierignore': 'plaintext',
  '.prettierrc': 'json',
  '.babelrc': 'json',
  '.eslintrc': 'json',
  license: 'plaintext',
  readme: 'markdown',
  changelog: 'markdown',
};

const LANGUAGE_BY_MEDIA_TYPE: Record<string, string> = {
  'text/markdown': 'markdown',
  'text/javascript': 'javascript',
  'application/javascript': 'javascript',
  'text/typescript': 'typescript',
  'text/css': 'css',
  'text/html': 'xml',
  'text/xml': 'xml',
  'application/xml': 'xml',
  'application/json': 'json',
  'application/ld+json': 'json',
  'application/x-ndjson': 'json',
  'application/yaml': 'yaml',
  'application/toml': 'ini',
  'application/sql': 'sql',
  'application/x-sh': 'bash',
  'text/x-python': 'python',
  'text/x-shellscript': 'bash',
};

// Which grammar (canonical name registered above) a workspace file should be
// shown with; null means "not a text file as far as we can tell" — the page
// then falls back to its "no viewer" card. Extension first (the most specific
// signal), then well-known basenames, then the server's mediaType: any text/*
// is at least plain text.
export function detectLanguage(file: { path: string; mediaType: string }): string | null {
  const basename = (file.path.split('/').pop() ?? file.path).toLowerCase();
  const dot = basename.lastIndexOf('.');
  const extension = dot > 0 ? basename.slice(dot + 1) : '';

  if (extension && LANGUAGE_BY_EXTENSION[extension]) {
    return LANGUAGE_BY_EXTENSION[extension];
  }

  if (LANGUAGE_BY_BASENAME[basename]) {
    return LANGUAGE_BY_BASENAME[basename];
  }

  // .env.local, .env.production, Dockerfile.dev, Makefile.inc…
  if (basename.startsWith('.env.')) {
    return 'ini';
  }

  if (basename.startsWith('dockerfile.')) {
    return 'dockerfile';
  }

  if (basename.startsWith('makefile.')) {
    return 'makefile';
  }

  const mediaType = file.mediaType.split(';')[0].trim().toLowerCase();

  if (LANGUAGE_BY_MEDIA_TYPE[mediaType]) {
    return LANGUAGE_BY_MEDIA_TYPE[mediaType];
  }

  if (mediaType.startsWith('text/')) {
    return 'plaintext';
  }

  return null;
}

// JSON is re-serialized with two-space indentation for reading (agents write
// it compact more often than not). Anything that does not parse as a single
// JSON document (JSON Lines, comments, trailing garbage) is shown as is.
export function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// Highlighted React nodes for one file's text; falls back to the plain
// string when the grammar is unknown or throws on the input.
export function highlightToReact(language: string, text: string): ReactNode {
  if (language === 'plaintext' || !lowlight.registered(language)) {
    return text;
  }

  try {
    const tree = lowlight.highlight(language, text);

    return toJsxRuntime(tree, { Fragment, jsx, jsxs });
  } catch {
    return text;
  }
}
