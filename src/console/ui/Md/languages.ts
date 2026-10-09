// The grammars the Markdown renderer highlights (design README, rule 18;
// ui.md): a curated set, not highlight.js's "common" — everything else
// renders as plain code. `html` is the xml grammar under the name agents
// write in fences.

import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

export const LANGUAGES = { bash, css, diff, javascript, json, markdown, python, sql, typescript, xml, yaml };

// Fence names agents use for the same grammars.
export const ALIASES: Record<string, string[]> = {
  bash: ['sh', 'shell', 'zsh', 'console'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  markdown: ['md'],
  python: ['py'],
  xml: ['html', 'svg', 'xhtml'],
  yaml: ['yml'],
};
