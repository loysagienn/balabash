// A text file → one HTML string per line for the code viewer: highlighted
// by highlight.js over the curated grammars (ui/Md/languages.ts) when a
// grammar is known, escaped text otherwise. Highlighting yields one HTML
// for the whole file with spans that may cross line breaks; splitting it
// into lines closes every open span at the end of a line and reopens it at
// the start of the next, so each line is self-contained markup.

import hljs from 'highlight.js/lib/core';
import { LANGUAGES } from '../../ui/Md/languages.ts';

let registered = false;

function ensureLanguages(): void {
  if (!registered) {
    for (const [name, grammar] of Object.entries(LANGUAGES)) {
      hljs.registerLanguage(name, grammar);
    }

    registered = true;
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TAG = /<\/?span[^>]*>/g;

export function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let line = '';
  let i = 0;

  const flush = () => {
    lines.push(line + '</span>'.repeat(open.length));
    line = open.join('');
  };

  while (i < html.length) {
    const next = html.indexOf('\n', i);
    const stop = next < 0 ? html.length : next;
    const chunk = html.slice(i, stop);
    let last = 0;

    TAG.lastIndex = 0;

    for (let m = TAG.exec(chunk); m; m = TAG.exec(chunk)) {
      line += chunk.slice(last, m.index) + m[0];
      last = m.index + m[0].length;

      if (m[0].startsWith('</')) {
        open.pop();
      } else {
        open.push(m[0]);
      }
    }

    line += chunk.slice(last);

    if (next < 0) {
      break;
    }

    flush();
    i = next + 1;
  }

  lines.push(line + '</span>'.repeat(open.length));

  return lines;
}

export function codeLines(source: string, language: string | null, highlight: boolean): string[] {
  // A trailing newline ends the last line; it is not an extra empty line.
  const text = source.endsWith('\n') ? source.slice(0, -1) : source;

  if (highlight && language) {
    ensureLanguages();

    try {
      return splitHighlighted(hljs.highlight(text, { language, ignoreIllegals: true }).value);
    } catch {
      // An unknown grammar name: plain lines.
    }
  }

  return text.split('\n').map(escapeHtml);
}
