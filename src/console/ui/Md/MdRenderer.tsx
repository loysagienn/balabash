// The Markdown renderer behind <Md> — react-markdown with GitHub
// extensions (tables, task lists, strikethrough, autolinks) and
// rehype-highlight over the curated grammars, inside the .md block. Raw
// HTML in the source is shown as text, never rendered. Loaded as its own
// chunk (Md.tsx).

import { createContext, useContext } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { ALIASES, LANGUAGES } from './languages.ts';
import type { MdPlace, MdProps } from './Md.tsx';
import { resolveRelative } from './relative.ts';

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

// The document's place in the file area (Md.tsx, `at`), read by the link
// and image components below — through a context, so the component map
// stays one object and the rendered elements keep their identity (an image
// is not requested again because the owner rendered again).
const PlaceContext = createContext<MdPlace | null>(null);

// Links to other sites open in a new tab; links into the console stay. In a
// placed document a relative link leads to the path it names in the file
// area — the owner's route, opened in place — and a relative image shows
// the bytes of its path. A table sits in its own scroll area (.md-table), so
// a wide one scrolls instead of widening the feed.
const COMPONENTS: Components = {
  a: ({ node: _node, href, children, ...rest }) => {
    const place = useContext(PlaceContext);
    const target = place && href !== undefined ? resolveRelative(place.path, href) : null;

    if (place && target) {
      const link = place.link(target.path);

      return (
        <a {...rest} href={`${link.href}${target.hash}`} onClick={link.onClick}>
          {children}
        </a>
      );
    }

    const external = href !== undefined && isExternal(href);

    return (
      <a {...rest} href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}>
        {children}
      </a>
    );
  },
  img: ({ node: _node, src, ...rest }) => {
    const place = useContext(PlaceContext);
    const target = place && typeof src === 'string' ? resolveRelative(place.path, src) : null;

    return <img {...rest} src={place && target ? place.bytes(target.path) : src} />;
  },
  table: ({ node: _node, ...rest }) => (
    <div className="md-table">
      <table {...rest} />
    </div>
  ),
};

export default function MdRenderer({ source, quiet, className, at }: MdProps) {
  return (
    <PlaceContext.Provider value={at ?? null}>
      <div className={className ? `md ${className}` : 'md'} data-variant={quiet ? 'quiet' : undefined}>
        <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
          {source}
        </ReactMarkdown>
      </div>
    </PlaceContext.Provider>
  );
}
