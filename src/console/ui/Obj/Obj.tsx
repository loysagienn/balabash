// Object icon (design: Obj): file, app, task, event. state — a tinted
// state background; kind="dir" — a folder without a backing.

import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import type { StateName } from '../atoms/atoms.tsx';
import './Obj.css';

export type ObjProps = {
  icon: IconName;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  state?: StateName;
  kind?: 'dir';
  className?: string;
};

export function Obj({ icon, size, state, kind, className }: ObjProps) {
  return (
    <span className={className ? `obj ${className}` : 'obj'} data-size={size} data-state={state} data-kind={kind}>
      <Icon name={icon} />
    </span>
  );
}
