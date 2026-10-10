// The words of the "Claude limits" cards (design: Limit rows on Home and
// System) over GET /api/limits: which windows a card shows, a row's title,
// reset line and state label, the footer's measurement and overage words,
// the note when there is no measurement. Pure, tested.

import type { ClaudeLimitsView, LimitOverageView, LimitWindowKind, LimitWindowView, LimitsResponse } from '../../../api/contract.ts';
import { countOf, dateTimeLabel, durationLabel, shortDate, timeOfDay } from '../../lib/format/index.ts';
import { ringLevel } from '../../ui/Ring/Ring.logic.ts';

export type LimitRow = {
  key: string;
  title: string;
  meta: string;
  // Percent used — the ring's value.
  value: number;
  label: string;
};

// Where the rows are shown: Home keeps to the plan-wide windows unless a
// narrower one is at a warning or exhausted; System lists every window.
export type LimitsScope = 'home' | 'all';

const TITLES: Record<Exclude<LimitWindowKind, 'model'>, string> = {
  five_hour: '5 hours',
  seven_day: '7 days',
  seven_day_opus: '7 days · Opus',
  seven_day_sonnet: '7 days · Sonnet',
  seven_day_oauth_apps: '7 days · OAuth apps',
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function windowTitle(window: Pick<LimitWindowView, 'kind' | 'model'>): string {
  return window.kind === 'model' ? `7 days · ${window.model ?? 'model'}` : TITLES[window.kind];
}

// "at 18:00" today, "Mon, 10:00" within the week, then "Oct 20, 10:00".
function resetMoment(resetsAt: Date, now: Date): string {
  if (sameDay(resetsAt, now)) {
    return `at ${timeOfDay(resetsAt)}`;
  }

  const ms = resetsAt.getTime() - now.getTime();

  if (ms > 0 && ms < 7 * DAY) {
    return `${resetsAt.toLocaleDateString('en-US', { weekday: 'short' })}, ${timeOfDay(resetsAt)}`;
  }

  return `${shortDate(resetsAt, now)}, ${timeOfDay(resetsAt)}`;
}

// "resets at 18:00 · in 1h 22m", "resets Mon, 10:00 · in 3d 17h"; a reset
// already behind now — the measurement predates it — says so; no reset
// known — says that.
export function resetWords(resetsAt: Date | null, now: Date): string {
  if (resetsAt === null) {
    return 'reset time unknown';
  }

  const ms = resetsAt.getTime() - now.getTime();

  if (ms <= 0) {
    return `reset ${resetMoment(resetsAt, now)} passed — measured before it`;
  }

  return `resets ${resetMoment(resetsAt, now)} · in ${ms < MINUTE ? 'under a minute' : durationLabel(ms)}`;
}

// The state label under the reset line, by the ring's rule (below 80 —
// normal, 80–99 — warning, 100 and above — exhausted; "· overage" when the
// requests go on past the plan at API rates). A refusal the API answered
// since the measurement shows as "refused" while the percentage is not yet
// at 100.
export function limitLabel(window: Pick<LimitWindowView, 'utilization' | 'status'>, overage: LimitOverageView | null): string {
  const level = ringLevel(window.utilization ?? 0);

  if (level === 'over') {
    return overage?.inUse ? 'exhausted · overage' : 'exhausted';
  }
  if (window.status === 'rejected') {
    return 'refused';
  }

  return level === 'warn' ? 'warning' : 'normal';
}

export function limitRows(limits: ClaudeLimitsView, scope: LimitsScope, now: Date): LimitRow[] {
  const rows: LimitRow[] = [];

  for (const window of limits.windows) {
    // Nothing to draw without a percentage.
    if (window.utilization === null) {
      continue;
    }

    const planWide = window.kind === 'five_hour' || window.kind === 'seven_day';

    if (scope === 'home' && !planWide && ringLevel(window.utilization) === undefined) {
      continue;
    }

    rows.push({
      key: window.kind === 'model' ? `model:${window.model ?? ''}` : window.kind,
      title: windowTitle(window),
      meta: resetWords(window.resetsAt, now),
      value: window.utilization,
      label: limitLabel(window, limits.overage),
    });
  }

  return rows;
}

// The footer: when the measurement was taken and whether anything can
// refresh it — "measured 16:31 · 2 Claude sessions live", "measured Oct 9,
// 23:10 · no Claude session running — the next run refreshes".
export function measuredWords(limits: ClaudeLimitsView, liveSessions: number, now: Date): string {
  const measured = `measured ${dateTimeLabel(limits.measuredAt, now)}`;

  return liveSessions > 0 ? `${measured} · ${countOf(liveSessions, 'Claude session')} live` : `${measured} · no Claude session running — the next run refreshes`;
}

function money(amount: number, currency: string | null): string {
  try {
    return amount.toLocaleString('en-US', { style: 'currency', currency: currency ?? 'USD' });
  } catch {
    // A currency code the browser has no table for.
    return `${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency}`;
  }
}

// "Overage on · $4.80 of $50.00 this month", "Overage on · in use: requests
// past the plan are billed at API rates · $4.80 this month", "Overage off";
// nothing when the endpoint said nothing about it.
export function overageWords(overage: LimitOverageView | null): string | null {
  if (overage === null) {
    return null;
  }
  if (!overage.enabled) {
    return 'Overage off';
  }

  const parts = ['Overage on'];

  if (overage.inUse) {
    parts.push('in use: requests past the plan are billed at API rates');
  }
  if (overage.usedCredits !== null) {
    const spent = money(overage.usedCredits, overage.currency);

    parts.push(overage.monthlyLimit !== null ? `${spent} of ${money(overage.monthlyLimit, overage.currency)} this month` : `${spent} this month`);
  }

  return parts.join(' · ');
}

// The note in place of the rows when the server has no measurement: why,
// and what brings one.
export function noLimitsWords(response: Pick<LimitsResponse, 'liveSessions' | 'lastSessionAt'>, now: Date): string {
  if (response.liveSessions > 0) {
    return `No limit data yet: ${countOf(response.liveSessions, 'Claude session is', 'Claude sessions are')} running, but none has answered a measurement.`;
  }
  if (response.lastSessionAt) {
    return `No limit data yet: the last Claude session ended ${dateTimeLabel(response.lastSessionAt, now)}; the next run measures them.`;
  }

  return 'No limit data yet: no Claude session has run since the app started; the next run measures them.';
}

export const UNAVAILABLE_WORDS = 'Plan limits do not apply to this account — it runs on an API key or a cloud provider.';
export const NO_WINDOWS_WORDS = 'The plan reported no windows with a percentage.';
