// Markdown block (design: .md): messages, the summary, file previews. The
// renderer (react-markdown, GFM, rehype-highlight with the curated
// grammars) is a lazy chunk; until it arrives the source is shown as plain
// paragraphs in a block of the same class, so the text is readable at
// once. quiet — intermediate agent text, one step quieter.

import { Suspense, lazy } from 'react';
import './Md.css';

const Renderer = lazy(() => import('./MdRenderer.tsx'));

export type MdProps = {
  source: string;
  quiet?: boolean;
  className?: string;
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
