// What the chip says for N running threads (design: ActivityChip renderVals).

import { plural } from '../../lib/format/index.ts';

export type ActivityChipVals = { quiet: boolean; n: number; label: string; aria: string };

export function activityChipVals(running: number): ActivityChipVals {
  const n = Math.max(0, Math.floor(running));
  const label = plural(n, 'thread running', 'threads running');

  return { quiet: n === 0, n, label, aria: n === 0 ? 'All quiet' : `${n} ${label}` };
}
