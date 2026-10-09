// Signed-out screen (design: Solo): sign-in, secrets entry, connection
// result, link errors, 404. One centered card, brand mark on top, an
// optional state icon. Children — the card's content.

import type { ReactNode } from 'react';
import type { IconName } from '../Icon/Icon.tsx';
import { Obj } from '../Obj/Obj.tsx';
import type { StateName } from '../atoms/atoms.tsx';
import './Solo.css';

export type SoloProps = {
  brand?: string;
  icon?: IconName;
  iconState?: StateName;
  title: string;
  children?: ReactNode;
};

export function Solo({ brand = 'Balabash', icon, iconState, title, children }: SoloProps) {
  return (
    <div className="solo">
      <div className="solo-wrap">
        <div className="solo-card">
          <div className="solo-brand">
            <span className="solo-logo">B</span>
            {brand}
          </div>
          {icon ? <Obj icon={icon} size="lg" state={iconState} className="solo-ic" /> : null}
          <h1 className="solo-t">{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}

export function SoloText({ children }: { children: ReactNode }) {
  return <p className="solo-d">{children}</p>;
}

export function SoloFoot({ children }: { children: ReactNode }) {
  return <div className="solo-f">{children}</div>;
}
