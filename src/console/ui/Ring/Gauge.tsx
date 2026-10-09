// Large ring with the number inside (design: Gauge): limits, disk, memory,
// context in thread details.

import { Ring } from './Ring.tsx';

export type GaugeProps = {
  value: number;
  className?: string;
};

export function Gauge({ value, className }: GaugeProps) {
  const text = `${Math.round(value)}%`;

  return (
    <span className={className ? `gauge ${className}` : 'gauge'} role="img" aria-label={text}>
      <Ring value={value} size="lg" />
      <b className="gauge-v">{text}</b>
    </span>
  );
}
