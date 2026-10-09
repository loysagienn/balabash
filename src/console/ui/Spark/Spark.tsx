// Mini bars (design: Spark): per core, traffic per hour. values — percent
// of the height; muted — dimmed. Decorative: the caller names the numbers.

import type { CSSProperties } from 'react';
import './Spark.css';

export function Spark({ values, muted, className }: { values: number[]; muted?: boolean; className?: string }) {
  return (
    <span className={className ? `spark ${className}` : 'spark'} data-muted={muted ? '' : undefined} aria-hidden="true">
      {values.map((value, i) => (
        <i key={i} style={{ '--v': `${Math.max(0, Math.min(value, 100))}%` } as CSSProperties} />
      ))}
    </span>
  );
}
