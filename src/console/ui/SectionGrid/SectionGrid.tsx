// Section tiles (design: .secgrid) — the "More" sheet on the phone. Each
// tile is a link the caller renders (the router's Link), so the block
// knows nothing of routes.

import type { ReactNode } from 'react';
import './SectionGrid.css';

export function SectionGrid({ children, label }: { children: ReactNode; label: string }) {
  return (
    <nav className="secgrid" aria-label={label}>
      {children}
    </nav>
  );
}
