// The period of the Threads route as the filter bar reads it: `from` and
// `to` are local calendar days of the URL (routes.ts), the chip's menu
// offers the usual windows as presets, and the chip's value names the
// period back — the preset's own word while the days still are that preset
// (a bookmark of "Today" keeps its days, so tomorrow it reads as the date),
// otherwise the days themselves.

import { dayKey, daysBefore, dayStart, shortDate } from '../../lib/format/index.ts';
import type { ThreadsRoute } from '../../lib/router/routes.ts';
import type { ThreadsFilterPatch } from './filters.ts';

export type Period = Pick<ThreadsRoute, 'from' | 'to'>;
export type PeriodPreset = 'today' | 'yesterday' | '7d' | '30d';

export const PERIOD_PRESETS: { id: PeriodPreset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
];

// The days of a preset at this moment: the windows ending today are open at
// the end (a thread started later today still belongs).
export function presetPeriod(preset: PeriodPreset, now: Date): Period {
  switch (preset) {
    case 'today':
      return { from: dayKey(now) };
    case 'yesterday': {
      const day = dayKey(daysBefore(now, 1));

      return { from: day, to: day };
    }
    case '7d':
      return { from: dayKey(daysBefore(now, 6)) };
    case '30d':
      return { from: dayKey(daysBefore(now, 29)) };
  }
}

// The route patch of a preset the user has just chosen: both days replaced
// with the preset's days at the moment of the choice. The time is read here,
// not taken from the last render — useNow refreshes once a minute, so right
// after midnight the rendered time is still yesterday's, and Yesterday chosen
// from it would keep the day before yesterday in the URL.
export function choosePreset(preset: PeriodPreset): ThreadsFilterPatch {
  const { from, to } = presetPeriod(preset, new Date());

  return { from, to };
}

export function samePeriod(a: Period, b: Period): boolean {
  return (a.from ?? null) === (b.from ?? null) && (a.to ?? null) === (b.to ?? null);
}

// The preset the period is at this moment, if any.
export function periodPreset(period: Period, now: Date): PeriodPreset | undefined {
  return PERIOD_PRESETS.find(p => samePeriod(presetPeriod(p.id, now), period))?.id;
}

// "Today", "Last 7 days", "Oct 1 – Oct 9", "Oct 3", "since Oct 3",
// "until Oct 9"; undefined without a period.
export function periodLabel(period: Period, now: Date): string | undefined {
  const preset = periodPreset(period, now);

  if (preset) {
    return PERIOD_PRESETS.find(p => p.id === preset)!.label;
  }

  const { from, to } = period;
  const day = (key: string) => shortDate(dayStart(key), now);

  if (from && to) {
    return from === to ? day(from) : `${day(from)} – ${day(to)}`;
  }
  if (from) {
    return `since ${day(from)}`;
  }
  if (to) {
    return `until ${day(to)}`;
  }

  return undefined;
}
