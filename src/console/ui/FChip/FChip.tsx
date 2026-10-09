// Filter chip (design: FChip). Without a value — "+ Add filter"; with a
// value — "Label: value ×" (or ▾ for a picker — end="chevron-down").

import type { MouseEvent } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import './FChip.css';

export type FChipProps = {
  label: string;
  value?: string;
  icon?: IconName;
  end?: 'x' | 'chevron-down';
  expanded?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
};

export function FChip({ label, value, icon = 'bot', end = 'x', expanded, onClick }: FChipProps) {
  if (!value) {
    return (
      <button type="button" className="fchip" aria-pressed="false" aria-expanded={expanded} onClick={onClick}>
        <Icon name="plus" />
        {label}
      </button>
    );
  }

  return (
    <button type="button" className="fchip" aria-pressed="true" aria-expanded={expanded} onClick={onClick}>
      <Icon name={icon} />
      {`${label}: `}
      <span className="fchip-v">{value}</span>
      <Icon name={end} />
    </button>
  );
}
