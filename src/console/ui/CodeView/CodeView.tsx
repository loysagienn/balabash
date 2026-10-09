// Code with line numbers (design: .codeview > .codeview-ln): one span per
// line, numbered by a CSS counter; each line's markup comes ready from the
// feature (features/file-area/codeLines.ts — highlight.js spans closed and
// reopened at line breaks, plain text escaped), so the viewer only places
// it.

import './CodeView.css';

export function CodeView({ lines }: { lines: string[] }) {
  return (
    <pre className="codeview">
      {lines.map((html, i) => (
        <span key={i} className="codeview-ln" dangerouslySetInnerHTML={{ __html: html }} />
      ))}
    </pre>
  );
}
