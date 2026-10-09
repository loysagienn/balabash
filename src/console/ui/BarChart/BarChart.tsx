// Bar chart, single series (design: BarChart): bars up to 24 px, a
// hairline grid, a tooltip on every bar (hover and keyboard focus), the
// current one highlighted. y — the scale labels bottom to top (the grid
// draws one line per label); cols — the bars: v in percent of the height,
// x — the label under the bar (or none), title and detail — the tooltip.
// Single series — no legend; a chart always has a table view next to it.
// Every column knows its index and the count (--i, --n): the CSS keeps the
// tooltip of an edge column inside the plot, where a card would clip it.

import type { CSSProperties } from 'react';
import { Tip } from '../Hint/Hint.tsx';
import './BarChart.css';

export type BarChartCol = {
  v: number;
  x?: string;
  title: string;
  detail?: string;
  current?: boolean;
};

export type BarChartProps = {
  // What assistive technology reads for the whole chart.
  label: string;
  y: string[];
  cols: BarChartCol[];
  className?: string;
};

export function BarChart({ label, y, cols, className }: BarChartProps) {
  return (
    <div className={className ? `chart ${className}` : 'chart'} role="img" aria-label={label}>
      <span className="chart-y" aria-hidden="true">
        {y.map((tick, i) => (
          <span key={i}>{tick}</span>
        ))}
      </span>
      <span className="chart-plot">
        <span className="chart-grid" aria-hidden="true">
          {y.map((_, i) => (
            <i key={i} />
          ))}
        </span>
        {cols.map((col, i) => (
          <span
            key={i}
            className="chart-col"
            style={{ '--v': Math.max(0, Math.min(col.v, 100)), '--i': i, '--n': cols.length } as CSSProperties}
            data-current={col.current ? '' : undefined}
            tabIndex={0}
          >
            <i className="chart-bar" />
            <Tip className="chart-tip">
              <b>{col.title}</b>
              {col.detail}
            </Tip>
          </span>
        ))}
      </span>
      <span className="chart-x" aria-hidden="true">
        {cols.map((col, i) => (
          <span key={i}>{col.x}</span>
        ))}
      </span>
    </div>
  );
}
