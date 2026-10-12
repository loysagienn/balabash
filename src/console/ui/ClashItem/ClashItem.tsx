// A name clash in the upload dialog (design: ClashItem): the file, what is
// in the folder now and what is being uploaded ("here 84 KiB · today 16:20
// — new 91 KiB"). The list of them is Clash.

import type { ReactNode } from 'react';
import type { IconName } from '../Icon/Icon.tsx';
import { Obj } from '../Obj/Obj.tsx';
import './ClashItem.css';

export function Clash({ children }: { children: ReactNode }) {
  return <div className="clash">{children}</div>;
}

export function ClashItem({ icon, name, meta }: { icon: IconName; name: string; meta: string }) {
  return (
    <div className="clash-i">
      <Obj icon={icon} size="sm" className="clash-ic" />
      <span className="clash-n" title={name}>
        {name}
      </span>
      <span className="clash-m">{meta}</span>
    </div>
  );
}
