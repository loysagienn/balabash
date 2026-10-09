// Filter bar (design: .fbar — the `fbar` container) above a list: modes
// and filters on the left (Seg, Tabs, FChip…), search and, when needed,
// "Create" on the right. Narrower than 640 px the search goes full width
// on top and the filters become a scrolling strip; on the phone the strip
// runs to the screen edges.

import type { ReactNode } from 'react';
import './FBar.css';

export function FBar({ filters, search, className }: { filters?: ReactNode; search?: ReactNode; className?: string }) {
  return (
    <div className={className ? `fbar ${className}` : 'fbar'}>
      {filters ? <div className="fbar-filters">{filters}</div> : null}
      {search ? <div className="fbar-search">{search}</div> : null}
    </div>
  );
}
