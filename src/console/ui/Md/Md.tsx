// Markdown block (design: .md): messages, the summary, file previews. The
// renderer (react-markdown, GFM, rehype-highlight with the curated
// grammars) is a lazy chunk; until it arrives the source is shown as plain
// paragraphs in a block of the same class, so the text is readable at
// once. quiet — intermediate agent text, one step quieter. at — the
// document's place in the file area, when it has one: relative links and
// images then lead into the file area from its folder.

import { Suspense, lazy } from 'react';
import type { MouseEventHandler } from 'react';
import './Md.css';

const Renderer = lazy(() => import('./MdRenderer.tsx'));

// The link of a path of the file area as the owner builds it: the href and
// the click that opens it in place — the pair the router's links carry.
export type MdLink = { href: string; onClick?: MouseEventHandler<HTMLAnchorElement> };

// Where a document sits in the file area. A relative reference in it
// resolves against the folder of `path` (relative.ts): a link becomes
// `link(path)`, an image's src becomes `bytes(path)` — the URL of the
// file's bytes. Messages of the feed have no place: their relative
// references stay as written.
export type MdPlace = { path: string; link: (path: string) => MdLink; bytes: (path: string) => string };

export type MdProps = {
  source: string;
  quiet?: boolean;
  className?: string;
  at?: MdPlace;
};

function Plain({ source, quiet, className }: MdProps) {
  return (
    <div className={className ? `md ${className}` : 'md'} data-variant={quiet ? 'quiet' : undefined} data-plain="">
      {source.split(/\n{2,}/).map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
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
