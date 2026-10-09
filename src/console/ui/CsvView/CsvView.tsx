// A table from delimited text (design: .csv): the first record as the
// header; cells that read as numbers are right-aligned (data-num). The
// body of the preview scrolls a wide table.

import './CsvView.css';

export type CsvViewProps = {
  header: string[];
  rows: string[][];
  numeric: (cell: string) => boolean;
};

export function CsvView({ header, rows, numeric }: CsvViewProps) {
  return (
    <table className="csv">
      {header.length > 0 ? (
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th key={i}>{cell}</th>
            ))}
          </tr>
        </thead>
      ) : null}
      <tbody>
        {rows.map((row, r) => (
          <tr key={r}>
            {row.map((cell, c) => (
              <td key={c} data-num={numeric(cell) ? '' : undefined}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
