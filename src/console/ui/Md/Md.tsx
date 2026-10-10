// Markdown block (design: .md): messages, the summary, file previews. The
// renderer (react-markdown, GFM, rehype-highlight with the curated
// grammars) is a lazy chunk; until it arrives the source is shown as plain
// paragraphs in a block of the same class, so the text is readable at
// once. quiet — intermediate agent text, one step quieter. at — the
// document's place in the file area, when it has one: relative links and
// images then lead into the file area from its folder, and the headings
// carry ids, so a fragment of the URL can name a section. reveal — the
// fragment to bring into view ('#part' or ''): once the document is
// rendered, the element it names is scrolled to the top of the view.
// breaks — a line break in the source is a line break on screen (a
// thought of Codex: the CLI joins the sections of a reasoning summary
// with one newline, which Markdown would fold into one line).

import { Suspense, lazy } from 'react';
import type { MouseEventHandler } from 'react';
import './Md.css';

const Renderer = lazy(() => import('./MdRenderer.tsx'));

// The link of a path of the file area as the owner builds it: the href,
// fragment included, and the click that opens it in place — the pair the
// router's links carry, so a click and a new tab land on the same URL.
export type MdLink = { href: string; onClick?: MouseEventHandler<HTMLAnchorElement> };

// Where a document sits in the file area. A relative reference in it
// resolves against the folder of `path` (relative.ts): a link becomes
// `link(path, hash)` — the fragment of the reference ('#part' or '') goes
// with it — an image's src becomes `bytes(path)` — the URL of the file's
// bytes (its fragment, an SVG's view, stays on the src). Messages of the
// feed have no place: their relative references stay as written.
export type MdPlace = { path: string; link: (path: string, hash: string) => MdLink; bytes: (path: string) => string };

export type MdProps = {
  source: string;
  quiet?: boolean;
  className?: string;
  at?: MdPlace;
  reveal?: string;
  breaks?: boolean;
};

function Plain({ source, quiet, className, breaks }: MdProps) {
  return (
    <div className={className ? `md ${className}` : 'md'} data-variant={quiet ? 'quiet' : undefined} data-plain="">
      {source.split(/\n{2,}/).map((paragraph, i) => (
        <p key={i}>
          {breaks
            ? paragraph.split('\n').map((line, j) => (
                <span key={j}>
                  {j > 0 ? <br /> : null}
                  {line}
                </span>
              ))
            : paragraph}
        </p>
      ))}
    </div>
  );
}

export function Md(props: MdProps) {
  return (
    <Suspense fallback={<Plain {...props} />}>
      <Renderer {...props} />
    </Suspense>
  );
}
