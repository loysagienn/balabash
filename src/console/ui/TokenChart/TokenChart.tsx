// Token chart (design: TokenChart): the composition of model tokens per
// request — two panels on one request axis, input (cached → cache write →
// uncached) and output (text → reasoning), each on its own scale; a legend
// with the window's totals; a tooltip on hover and keyboard focus of a
// column, opening towards the side of the visible plot with the room for it,
// dismissed by Escape until the next column. Narrower than 560 the plot
// scrolls sideways, opened at the newest request, and a detail block under
// the chart shows the selected request (the newest until a column is tapped;
// the selection is the request's id, so a moved window keeps it while the
// request is still there). view="table" — the same requests as a data table,
// newest first, the first rowsMax of them. The rules — TokenChart.logic.ts.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, PointerEvent } from 'react';
import type { CSSProperties } from 'react';
import { DataTable } from '../DataTable/DataTable.tsx';
import type { DataTableCol } from '../DataTable/DataTable.tsx';
import { Tip } from '../Hint/Hint.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { ErrorLine } from '../atoms/atoms.tsx';
import { buildTokenChart, tokenTableRows } from './TokenChart.logic.ts';
import type { TokenDetail, TokenRequest } from './TokenChart.logic.ts';
import './TokenChart.css';

export type TokenChartProps = {
  // Oldest first.
  reqs: TokenRequest[];
  view?: 'chart' | 'table';
  rowsMax?: number;
  // The moment the labels are relative to (a request on another day names it).
  now: Date;
  className?: string;
};

const TABLE_COLS: DataTableCol[] = [
  { label: 'time' },
  { label: 'request', wide: true },
  { label: 'input', num: true },
  { label: 'cached', num: true },
  { label: 'cache write', num: true },
  { label: 'uncached', num: true, wide: true },
  { label: 'output', num: true },
  { label: 'reasoning', num: true, wide: true },
  { label: 'duration', num: true, wide: true },
];

function Detail({ detail }: { detail: TokenDetail }) {
  return (
    <>
      <span className="tchart-tip-h">
        <b>{detail.title}</b>
        <span>{detail.sub}</span>
        {detail.sub2 ? <span>{detail.sub2}</span> : null}
        {detail.error ? <ErrorLine>{detail.error}</ErrorLine> : null}
      </span>
      {detail.ok ? (
        <span className="tchart-rows">
          {detail.rows.map(row => (
            <span key={row.label} className="tchart-row" data-g={row.group ? '' : undefined}>
              <i className="tchart-sw" data-s={row.s} style={row.s ? undefined : { visibility: 'hidden' }} />
              <span>{row.label}</span>
              <span className="tchart-v">{row.value}</span>
              <span className="tchart-pc">{row.share}</span>
            </span>
          ))}
        </span>
      ) : null}
      {detail.note ? <span className="tchart-note">{detail.note}</span> : null}
    </>
  );
}

// The tooltip's width plus its offset from the column (TokenChart.css).
const TIP_ROOM = 264 + 8;

function Chart({ reqs, now, className }: { reqs: TokenRequest[]; now: Date; className?: string }) {
  const model = useMemo(() => buildTokenChart(reqs, now), [reqs, now]);
  const tipId = useId();
  // The selected request (its id); null — the newest.
  const [selected, setSelected] = useState<string | null>(null);
  // Where the tooltip of the column under the pointer or focus opens, by the
  // visible part of the plot: to the left when the right has no room for it
  // and the left has more.
  const [placed, setPlaced] = useState<{ key: string; flip: boolean } | null>(null);
  // The column whose tooltip Escape dismissed: quiet until the pointer or
  // the focus comes back to it; other columns show their own.
  const [hushed, setHushed] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const last = model.cols.length - 1;
  const selectedAt = selected === null ? -1 : model.cols.findIndex(col => col.key === selected);
  const current = selectedAt >= 0 ? selectedAt : last;
  const newest = reqs[last]?.at.getTime() ?? 0;

  const place = (key: string, el: HTMLElement) => {
    const view = scroll.current?.getBoundingClientRect();
    const col = el.getBoundingClientRect();

    if (view) {
      const right = view.right - col.right;
      const left = col.left - view.left;

      setPlaced({ key, flip: right < TIP_ROOM && left > right });
    }
    // Back on the dismissed column its tooltip returns; another column's
    // pointer leaves the focused one quiet.
    setHushed(h => (h === key ? null : h));
  };
  const enter = (key: string) => (event: PointerEvent<HTMLElement>) => place(key, event.currentTarget);
  const focus = (key: string) => (event: FocusEvent<HTMLElement>) => {
    place(key, event.currentTarget);
    setSelected(key);
  };
  const keyDown = (key: string) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      setHushed(key);
    }
  };

  // Open at the newest request once the layout and the fonts have settled;
  // again when newer requests arrive.
  useEffect(() => {
    const end = () => {
      if (scroll.current) {
        scroll.current.scrollLeft = scroll.current.scrollWidth;
      }
    };

    end();

    const frame = requestAnimationFrame(end);
    const timer = setTimeout(end, 300);

    void document.fonts?.ready.then(end);

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [newest]);

  return (
    <div className={className ? `tchart ${className}` : 'tchart'}>
      <div className="tchart-legend">
        <div className="tchart-lg">
          <div className="tchart-lg-h">
            <b>Input</b>
            <span>{model.inHead}</span>
          </div>
          <div className="tchart-lg-items">
            {model.keysIn.map(key => (
              <span key={key.s} className="tchart-key" data-s={key.s}>
                <i className="tchart-sw" />
                <span>
                  {key.label} <b>{key.value}</b>
                  {key.share ? ` · ${key.share}` : ''}
                </span>
              </span>
            ))}
          </div>
        </div>
        <div className="tchart-lg">
          <div className="tchart-lg-h">
            <b>Output</b>
            <span>{model.outHead}</span>
          </div>
          <div className="tchart-lg-items">
            {model.keysOut.map(key => (
              <span key={key.s} className="tchart-key" data-s={key.s}>
                <i className="tchart-sw" />
                <span>
                  {key.label} <b>{key.value}</b>
                </span>
              </span>
            ))}
          </div>
        </div>
        <div className="tchart-lg">
          <div className="tchart-lg-h">
            <b>Requests</b>
            <span>{model.requests} · one column each</span>
          </div>
          <div className="tchart-lg-items">
            <span className="tchart-key">
              <i className="tchart-ka" />
              <span>
                keepalive ping <b>{model.pings}</b>
              </span>
            </span>
            <span className="tchart-key">
              <Icon name="x" className="tchart-err" />
              <span>
                failed <b>{model.failures}</b>
              </span>
            </span>
          </div>
        </div>
      </div>
      <div className="tchart-frame" role="img" aria-label={model.aria}>
        <div className="tchart-y" aria-hidden="true">
          <span className="tchart-y-t">Input</span>
          <span className="tchart-y-s" data-p="in">
            <span>{model.yInWidest}</span>
            {model.yIn.map((tick, i) => (
              <span key={i} style={{ '--p': tick.p } as CSSProperties}>
                {tick.label}
              </span>
            ))}
          </span>
          <span className="tchart-y-t">Output</span>
          <span className="tchart-y-s" data-p="out">
            <span>{model.yOutWidest}</span>
            {model.yOut.map((tick, i) => (
              <span key={i} style={{ '--p': tick.p } as CSSProperties}>
                {tick.label}
              </span>
            ))}
          </span>
        </div>
        <div className="tchart-scroll" ref={scroll}>
          <div className="tchart-plot">
            <span className="tchart-grid" data-p="in" aria-hidden="true">
              {model.yIn.map((_, i) => (
                <i key={i} />
              ))}
            </span>
            <span className="tchart-grid" data-p="out" aria-hidden="true">
              {model.yOut.map((_, i) => (
                <i key={i} />
              ))}
            </span>
            {model.cols.map((col, j) => (
              <span
                key={col.key}
                className="tchart-req"
                data-first={col.first ? '' : undefined}
                data-turn={col.turnStart ? '' : undefined}
                data-hour={col.hour ? '' : undefined}
                data-tail={col.tail ? '' : undefined}
                data-flip={(placed?.key === col.key ? placed.flip : col.flip) ? '' : undefined}
                data-sel={j === current ? '' : undefined}
                data-hush={hushed === col.key ? '' : undefined}
                tabIndex={0}
                aria-label={col.aria}
                aria-describedby={`${tipId}-${j}`}
                onClick={() => setSelected(col.key)}
                onPointerEnter={enter(col.key)}
                onFocus={focus(col.key)}
                onKeyDown={keyDown(col.key)}
              >
                <span className="tchart-in">
                  {col.segIn.map(seg => (
                    <i key={seg.s} className="tchart-seg" data-s={seg.s} data-top={seg.top ? '' : undefined} style={{ '--v': seg.v } as CSSProperties} />
                  ))}
                </span>
                <span className="tchart-out">
                  {col.segOut.map(seg => (
                    <i key={seg.s} className="tchart-seg" data-s={seg.s} data-top={seg.top ? '' : undefined} style={{ '--v': seg.v } as CSSProperties} />
                  ))}
                </span>
                <span className="tchart-mk">
                  {col.keepalive ? <i className="tchart-ka" /> : null}
                  {col.failed ? <Icon name="x" className="tchart-err" /> : null}
                </span>
                <span className="tchart-x">{col.label ? <span>{col.label}</span> : null}</span>
                <Tip id={`${tipId}-${j}`} className="tchart-tip">
                  <Detail detail={col.detail} />
                </Tip>
              </span>
            ))}
          </div>
        </div>
      </div>
      {model.cols[current] ? (
        <div className="tchart-detail">
          <Detail detail={model.cols[current].detail} />
          <span className="tchart-note">Swipe for earlier requests · tap a column to inspect it</span>
        </div>
      ) : null}
    </div>
  );
}

export function TokenChart({ reqs, view = 'chart', rowsMax, now, className }: TokenChartProps) {
  const rows = useMemo(() => (view === 'table' ? tokenTableRows(reqs, now) : []), [reqs, now, view]);

  if (view === 'table') {
    const shown = rowsMax === undefined ? rows : rows.slice(0, rowsMax);

    return (
      <div className={className ? `tchart ${className}` : 'tchart'}>
        <DataTable
          label="Tokens per request"
          cols={TABLE_COLS}
          rows={shown.map(row => ({ key: row.key, cells: [row.time, row.kind, row.input, row.cached, row.write, row.fresh, row.output, row.reasoning, row.duration] }))}
        />
      </div>
    );
  }

  return <Chart reqs={reqs} now={now} className={className} />;
}
