// Data table (design: .dtable in its .dtable-wrap — the `dtable`
// container): numbers right-aligned in tabular figures; columns marked
// wide hide when the wrapper is narrower than 520 px, the main ones stay.
// DtShare (design: DtShare) — a share as a short accent bar and a
// percentage; DtWho — an agent cell: avatar and name.

import type { CSSProperties, ReactNode } from 'react';
import { Avatar } from '../Avatar/Avatar.tsx';
import './DataTable.css';

export type DataTableCol = {
  label: ReactNode;
  // Numbers: right-aligned, in the column and its cells.
  num?: boolean;
  // Hidden when the table is cramped.
  wide?: boolean;
};

export type DataTableRow = { key: string; cells: ReactNode[] };

export type DataTableProps = {
  cols: DataTableCol[];
  rows: DataTableRow[];
  // What assistive technology reads for the table.
  label?: string;
  // Outer column padding (= the padding of the card around it).
  edge?: string;
  className?: string;
};

export function DataTable({ cols, rows, label, edge, className }: DataTableProps) {
  return (
    <div className={className ? `dtable-wrap ${className}` : 'dtable-wrap'}>
      <table className="dtable" aria-label={label} style={edge ? ({ '--dtable-edge': edge } as CSSProperties) : undefined}>
        <thead>
          <tr>
            {cols.map((col, i) => (
              <th key={i} data-num={col.num ? '' : undefined} data-wide={col.wide ? '' : undefined}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.key}>
              {cols.map((col, i) => (
                <td key={i} data-num={col.num ? '' : undefined} data-wide={col.wide ? '' : undefined}>
                  {row.cells[i]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DtShare({ value }: { value: number }) {
  const percent = Math.max(0, Math.min(Math.round(value), 100));

  return (
    <span className="dtable-share">
      <i className="dtable-bar" style={{ '--v': `${percent}%` } as CSSProperties} aria-hidden="true" />
      {percent}%
    </span>
  );
}

export function DtWho({ agent, children }: { agent: string; children?: ReactNode }) {
  return (
    <span className="dtable-who">
      <Avatar agent={agent} size="xs" />
      {children ?? agent}
    </span>
  );
}
