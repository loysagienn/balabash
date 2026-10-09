// Key–value pairs (design: .kv): a definition list in two columns — the
// thread rail, file details. mono — technical values; dtW — a shared label
// width when several lists stack (the rail sets it for all of its lists).

import { Fragment } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import './KeyValue.css';

export type KeyValueItem = { key: string; value: ReactNode };

export function KeyValue({
  items,
  mono,
  dtW,
  className,
}: {
  items: KeyValueItem[];
  mono?: boolean;
  dtW?: string;
  className?: string;
}) {
  return (
    <dl
      className={className ? `kv ${className}` : 'kv'}
      data-variant={mono ? 'mono' : undefined}
      style={dtW ? ({ '--kv-dt-w': dtW } as CSSProperties) : undefined}
    >
      {items.map(item => (
        <Fragment key={item.key}>
          <dt>{item.key}</dt>
          <dd>{item.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
