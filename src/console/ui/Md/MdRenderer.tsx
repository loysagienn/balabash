// The Markdown renderer behind <Md> — react-markdown with GitHub
// extensions (tables, task lists, strikethrough, autolinks) and
// rehype-highlight over the curated grammars, inside the .md block. Raw
// HTML in the source is shown as text, never rendered. Loaded as its own
// chunk (Md.tsx).

import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { ALIASES, LANGUAGES } from './languages.ts';
import type { MdProps } from './Md.tsx';

const REMARK = [remarkGfm];
const REHYPE = [[rehypeHighlight, { languages: LANGUAGES, aliases: ALIASES }]] as const;

// Links to other sites open in a new tab; links into the console stay.
const COMPONENTS: Components = {
  a: ({ node: _node, href, children, ...rest }) => {
    const external =
      href !== undefined && /^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith(window.location.origin);

    return (
      <a {...rest} href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}>
        {children}
      </a>
    );
  },
};

export default function MdRenderer({ source, quiet, className }: MdProps) {
  return (
    <div className={className ? `md ${className}` : 'md'} data-variant={quiet ? 'quiet' : undefined}>
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE as never} components={COMPONENTS}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
