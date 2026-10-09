// Section screen content: gutters and vertical rhythm (design: .screen).

import type { ReactNode } from 'react';
import './Screen.css';

export function Screen({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `screen ${className}` : 'screen'}>{children}</div>;
}
