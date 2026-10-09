// Loading placeholders (design: SkelStack, SkelRow): the same shape as the
// data. Skel — one shimmering shape; SkelStack — lines in a column, the
// first regular and the rest thin (smFirst — the other way round); SkelRow —
// a list row: avatar, lines, a pill on the right.

import type { CSSProperties } from 'react';
import '../List/List.css';
import './Skel.css';

export type SkelShape = 'line' | 'line-sm' | 'av' | 'pill';

export function Skel({ shape, w }: { shape?: SkelShape; w?: number }) {
  const style = w === undefined ? undefined : ({ '--w': `${w}%` } as CSSProperties);

  return <span className="skel" data-shape={shape === 'line' ? undefined : shape} style={style} />;
}

// widths — in percent of the stack.
export function SkelStack({ widths, smFirst }: { widths: number[]; smFirst?: boolean }) {
  return (
    <span className="skel-stack">
      {widths.map((w, i) => (
        <Skel key={i} shape={(smFirst ? i === 0 : i > 0) ? 'line-sm' : 'line'} w={w} />
      ))}
    </span>
  );
}

export function SkelRow({ widths = [62, 38], pill = true }: { widths?: number[]; pill?: boolean }) {
  return (
    <div className="row" aria-hidden="true">
      <Skel shape="av" />
      <span className="row-main">
        <SkelStack widths={widths} />
      </span>
      {pill ? (
        <span className="row-end">
          <Skel shape="pill" />
        </span>
      ) : null}
    </div>
  );
}
