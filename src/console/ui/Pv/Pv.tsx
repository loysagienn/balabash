// File preview (design: .pv, PvHead, PvNote): the header with the object
// icon, name, path and details and the actions on the right (PvHead —
// children are the actions: "Edit" for .md, download, copy path); the
// agent's description of the file above the content (PvNote); the
// scrolling body (PvBody — Markdown, a viewer or a MetaCard); and the
// action bar at the bottom (PvActBar) that replaces the header actions
// when the area is narrower than 720 px. On the phone the file name is
// already in the shell header — the preview header keeps the details.

import type { ReactNode } from 'react';
import { Avatar } from '../Avatar/Avatar.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { Obj } from '../Obj/Obj.tsx';
import { Code } from '../atoms/atoms.tsx';
import './Pv.css';

export function Pv({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `pv ${className}` : 'pv'}>{children}</div>;
}

export type PvHeadProps = {
  icon?: IconName;
  name: string;
  path?: string;
  // Details after the path: size, modified time, dimensions, pages.
  meta?: string[];
  children?: ReactNode;
};

export function PvHead({ icon = 'file-text', name, path, meta = [], children }: PvHeadProps) {
  return (
    <div className="pv-h">
      <Obj icon={icon} size="md" />
      <div className="pv-t">
        <b className="pv-name">{name}</b>
        <div className="pv-m">
          {path ? (
            <span>
              <Code>{path}</Code>
            </span>
          ) : null}
          {meta.map((item, i) => (
            <span key={i}>{item}</span>
          ))}
        </div>
      </div>
      {children ? <div className="pv-acts">{children}</div> : null}
    </div>
  );
}

export function PvNote({ agent, title, children }: { agent: string; title: string; children: ReactNode }) {
  return (
    <div className="pv-note">
      <Avatar agent={agent} size="sm" />
      <div>
        <strong>{title}</strong> — {children}
      </div>
    </div>
  );
}

export function PvBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `pv-b ${className}` : 'pv-b'}>{children}</div>;
}

export function PvActBar({ children }: { children: ReactNode }) {
  return <div className="pv-actbar">{children}</div>;
}
