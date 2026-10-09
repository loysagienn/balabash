// Icon button (design: IconBtn). Quiet (ghost) by default; variant=""
// (regular) — with a border. The label is for assistive technology.

import type { MouseEvent } from 'react';
import { Btn } from '../Btn/Btn.tsx';
import type { BtnSize, BtnVariant } from '../Btn/Btn.tsx';
import type { IconName } from '../Icon/Icon.tsx';

export type IconBtnProps = {
  icon: IconName;
  label: string;
  variant?: BtnVariant | 'regular';
  size?: BtnSize;
  className?: string;
  disabled?: boolean;
  busy?: boolean;
  expanded?: boolean;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
};

export function IconBtn({
  icon,
  label,
  variant = 'ghost',
  size,
  className,
  disabled,
  busy,
  expanded,
  onClick,
}: IconBtnProps) {
  return (
    <Btn
      icon={icon}
      iconOnly
      ariaLabel={label}
      title={label}
      variant={variant === 'regular' ? undefined : variant}
      size={size}
      className={className}
      disabled={disabled}
      busy={busy}
      expanded={expanded}
      onClick={onClick}
    />
  );
}
