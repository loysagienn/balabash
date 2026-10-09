// The Markdown renderer behind <Md> — react-markdown with GitHub
// extensions (tables, task lists, strikethrough, autolinks) and
// rehype-highlight over the curated grammars, inside the .md block. Raw
// HTML in the source is shown as text, never rendered. Loaded as its own
// chunk (Md.tsx).

import ReactMarkdown from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { ALIASES, LANGUAGES } from './languages.ts';
import type { MdProps } from './Md.tsx';

type Plugins = NonNullable<Options['rehypePlugins']>;

const REMARK: Plugins = [remarkGfm];
const REHYPE: Plugins = [[rehypeHighlight, { languages: LANGUAGES, aliases: ALIASES }]];

// A link leads out of the console when, resolved against the page, it is an
// http(s) URL of another origin — so "//host/…" and "https://<console host>.
// other.tld/…" count as external, mailto: and relative paths do not.
function isExternal(href: string): boolean {
  try {
    const url = new URL(href, window.location.href);

    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

// Links to other sites open in a new tab; links into the console stay. A
// table sits in its own scroll area (.md-table), so a wide one scrolls
// instead of widening the feed.
const COMPONENTS: Components = {
  a: ({ node: _node, href, children, ...rest }) => {
    const external = href !== undefined && isExternal(href);

    return (
      <a {...rest} href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}>
        {children}
      </a>
    );
  },
  table: ({ node: _node, ...rest }) => (
    <div className="md-table">
      <table {...rest} />
    </div>
  ),
};

export default function MdRenderer({ source, quiet, className }: MdProps) {
  return (
    <div className={className ? `md ${className}` : 'md'} data-variant={quiet ? 'quiet' : undefined}>
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
