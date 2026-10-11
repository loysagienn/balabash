// Workspace mark (design: WsMark): the initial of the workspace name on a
// solid identity fill — color 1–8, this browser's choice per workspace
// (lib/workspace). The name is its title.

import './WsMark.css';

export type WsMarkProps = {
  name: string;
  color: number;
  size?: 'sm';
  className?: string;
};

export function wsInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}

export function WsMark({ name, color, size, className }: WsMarkProps) {
  return (
    <span className={className ? `wsm ${className}` : 'wsm'} data-id={String(color)} data-size={size} title={name} aria-hidden="true">
      {wsInitial(name)}
    </span>
  );
}
