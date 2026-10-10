// The Markdown renderer behind <Md> — react-markdown with GitHub
// extensions (tables, task lists, strikethrough, autolinks) and
// rehype-highlight over the curated grammars, inside the .md block. Raw
// HTML in the source is shown as text, never rendered. A placed document
// (`at`) gets ids on its headings (rehype-slug — `user-content-` + the
// GitHub slug of the heading's text, fragment.ts: a namespace of the
// document's own, apart from the ids of the interface, while a link
// written for GitHub lands here too); a message of the feed does not: its
// headings are not addresses. With `breaks`, a newline of the source is a
// line break on screen (remark-breaks: text nodes only — code is not
// touched). Loaded as its own chunk (Md.tsx).

import { createContext, useContext, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeSlug from 'rehype-slug';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { HEADING_IDS, fragmentTarget } from './fragment.ts';
import { ALIASES, LANGUAGES } from './languages.ts';
import type { MdPlace, MdProps } from './Md.tsx';
import { resolveRelative } from './relative.ts';

type Plugins = NonNullable<Options['rehypePlugins']>;

const REMARK: Plugins = [remarkGfm];
const REMARK_BREAKS: Plugins = [...REMARK, remarkBreaks];
const REHYPE: Plugins = [[rehypeHighlight, { languages: LANGUAGES, aliases: ALIASES }]];
const REHYPE_PLACED: Plugins = [...REHYPE, [rehypeSlug, HEADING_IDS]];

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
// area — the owner's route with the link's fragment, opened in place — and
// a relative image shows the bytes of its path, its fragment kept (an SVG's
// view). A reference the file area cannot hold (relative.ts) stays as
// written. A table sits in its own scroll area (.md-table), so a wide one
// scrolls instead of widening the feed.
const COMPONENTS: Components = {
  a: ({ node: _node, href, children, ...rest }) => {
    const place = useContext(PlaceContext);
    const target = place && href !== undefined ? resolveRelative(place.path, href) : null;

    if (place && target) {
      const link = place.link(target.path, target.hash);

      return (
        <a {...rest} href={link.href} onClick={link.onClick}>
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

    return <img {...rest} src={place && target ? `${place.bytes(target.path)}${target.hash}` : src} />;
  },
  table: ({ node: _node, ...rest }) => (
    <div className="md-table">
      <table {...rest} />
    </div>
  ),
};

// The fragment named by `reveal` comes to the top of the view once the
// document is rendered — on arrival of the text and of this chunk, and
// again when the fragment changes under the same document. The element is
// the heading of the fragment's slug, looked up inside this document only
// (fragment.ts); the browser's own move to the fragment finds no element
// of that id and leaves the view alone, so this is the one move.
// scrollIntoView moves
// the scroll box the document sits in and its scrolling ancestors (the
// preview's own body, and on a project page the shell's body too — the
// file card comes up, the screen's own rule for a move to a file); once
// more on the next frame — after every effect of the shell, which resets
// a new screen to the top after the children's effects ran (the feed's
// own rule in ThreadScreen). A fragment naming nothing leaves the view
// where it is.
function useReveal(root: { current: HTMLDivElement | null }, source: string, reveal: string | undefined): void {
  useEffect(() => {
    const target = reveal && root.current ? fragmentTarget(root.current, reveal) : null;

    if (!target) {
      return undefined;
    }

    const show = () => target.scrollIntoView({ block: 'start' });

    show();

    const frame = requestAnimationFrame(show);

    return () => cancelAnimationFrame(frame);
  }, [root, source, reveal]);
}

export default function MdRenderer({ source, quiet, className, at, reveal, breaks }: MdProps) {
  const root = useRef<HTMLDivElement>(null);

  useReveal(root, source, reveal);

  return (
    <PlaceContext.Provider value={at ?? null}>
      <div ref={root} className={className ? `md ${className}` : 'md'} data-variant={quiet ? 'quiet' : undefined}>
        <ReactMarkdown remarkPlugins={breaks ? REMARK_BREAKS : REMARK} rehypePlugins={at ? REHYPE_PLACED : REHYPE} components={COMPONENTS}>
          {source}
        </ReactMarkdown>
      </div>
    </PlaceContext.Provider>
  );
}
