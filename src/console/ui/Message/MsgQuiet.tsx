// Intermediate agent text (design: MsgQuiet) — one step quieter, no
// header, indented to the avatar column. children — an <Md quiet>.

import type { ReactNode } from 'react';
import './Message.css';

export function MsgQuiet({ children }: { children: ReactNode }) {
  return (
    <div className="msg" data-variant="quiet">
      {children}
    </div>
  );
}
