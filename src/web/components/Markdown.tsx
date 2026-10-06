'use client';

// Markdown as the window renders it everywhere (workspace viewers, chat
// messages): react-markdown with raw HTML left unrendered (the library's
// default — the text is agent- or user-written, never trusted), fenced
// blocks highlighted through the curated grammar registry of lib/highlight.

import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { aliases, languages } from '../lib/highlight';
import styles from './markdown.module.css';

// `txt`/`text` fences stay plain on purpose.
const rehypePlugins: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  [rehypeHighlight, { languages, aliases, plainText: ['txt', 'text', 'plain'] }],
];

// The theme class alone, for containers that highlight without Markdown
// (the code viewer).
export const highlightClass = styles.hl;

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={`${styles.markdown} ${styles.hl}${className ? ` ${className}` : ''}`}>
      <ReactMarkdown rehypePlugins={rehypePlugins}>{children}</ReactMarkdown>
    </div>
  );
}
