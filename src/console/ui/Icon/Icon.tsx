// <Icon name="play" size="sm" spin /> → <svg class="ic" data-size="sm"
// data-spin>: the design's .ic block (size by font-size) over lucide SVGs.

import type { SVGProps } from 'react';
import { ICONS } from './icons.ts';
import type { IconName } from './icons.ts';
import './Icon.css';

export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'name' | 'size'> & {
  name: IconName;
  size?: IconSize;
  spin?: boolean;
};

export function Icon({ name, size, spin, className, ...rest }: IconProps) {
  const Component = ICONS[name];

  return (
    <Component
      {...rest}
      className={className ? `ic ${className}` : 'ic'}
      data-size={size}
      data-spin={spin ? '' : undefined}
      aria-hidden={rest['aria-label'] ? undefined : true}
      focusable="false"
    />
  );
}

export type { IconName };
