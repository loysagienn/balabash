// A file without a preview (design: MetaCard): a large object icon, the
// name, the details (children — type, size, modified, who created it, why
// there is no preview) and the actions — "Download" (the feature gives the
// link). Sits in the preview body (PvBody).

import type { ReactNode } from 'react';
import type { IconName } from '../Icon/Icon.tsx';
import { Obj } from '../Obj/Obj.tsx';
import './MetaCard.css';

export type MetaCardProps = {
  icon?: IconName;
  name: string;
  children: ReactNode;
  actions?: ReactNode;
};

export function MetaCard({ icon = 'file-text', name, children, actions }: MetaCardProps) {
  return (
    <div className="metacard">
      <Obj icon={icon} size="xl" className="metacard-ic" />
      <b className="metacard-t">{name}</b>
      <p className="metacard-d">{children}</p>
      {actions ? <div className="metacard-acts">{actions}</div> : null}
    </div>
  );
}
