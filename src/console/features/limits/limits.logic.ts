// The words of the "Plan limits" card (design: Limit rows on Home and
// System) over GET /api/limits, a group per account: which windows a card
// shows, a row's title, reset line and state label, the group's plan and
// footer (the measurement, Claude's overage, Codex's credits), the notes
// when there is no measurement or the account is refusing. Pure, tested.

import type { ClaudeLimitsResponse, ClaudeLimitsView, CodexBucketView, CodexLimitWindowView, CodexLimitsView, LimitFailureView, LimitOverageView, LimitWindowKind, LimitWindowView, LimitsResponse } from '../../../api/contract.ts';
import { countOf, dateTimeLabel, durationLabel, shortDate, timeOfDay } from '../../lib/format/index.ts';
import type { RingLevel } from '../../ui/Ring/Ring.logic.ts';
import { ringLevel } from '../../ui/Ring/Ring.logic.ts';

export type LimitRow = {
  key: string;
  title: string;
  meta: string;
  // Percent used — the ring's value.
  value: number;
  label: string;
  // The level of the state label: the ring's, raised to a warning by what
  // the API answered since the measurement.
  level: RingLevel | undefined;
};

// Where the rows are shown: Home keeps to the plan-wide windows and the
// per-model ones (the server's current meters — the models the agents run
// on), the older narrow kinds (Opus, Sonnet, OAuth apps) only at a warning
// or exhausted — by their percentage or by the API's answer since the
// measurement; System lists every window.
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

// "at 18:00" today, "Mon, 10:00" within the week, then "Oct 20, 10:00". The
// moment is named to the nearest minute: the endpoints state a reset on a
// minute boundary and jitter around it by a second between measurements —
// cut off, the seconds would turn "Tue, 00:00" into "Mon, 23:59" from one
// read to the next.
function resetMoment(at: Date, now: Date): string {
  const resetsAt = new Date(Math.round(at.getTime() / MINUTE) * MINUTE);

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

// The level of a window: the ring's rule over its percentage (below 80 —
// none, 80–99 — warn, 100 and above — over), raised to warn by a warning or
// a refusal the API answered since the measurement — the percentage is the
// measurement's, the API's answer is newer.
export function limitLevel(window: Pick<LimitWindowView, 'utilization' | 'status'>): RingLevel | undefined {
  const level = ringLevel(window.utilization ?? 0);

  if (level === undefined && (window.status === 'allowed_warning' || window.status === 'rejected')) {
    return 'warn';
  }

  return level;
}

// The state label under the reset line: normal, warning, exhausted ("·
// overage" when the requests go on past the plan at API rates) by the
// level; a refusal the API answered since the measurement shows as
// "refused" while the percentage is not yet at 100.
export function limitLabel(window: Pick<LimitWindowView, 'utilization' | 'status'>, overage: LimitOverageView | null): string {
  const level = limitLevel(window);

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

    const onHome = window.kind === 'five_hour' || window.kind === 'seven_day' || window.kind === 'model';
    const level = limitLevel(window);

    if (scope === 'home' && !onHome && level === undefined) {
      continue;
    }

    rows.push({
      key: window.kind === 'model' ? `model:${window.model ?? ''}` : window.kind,
      title: windowTitle(window),
      meta: resetWords(window.resetsAt, now),
      value: window.utilization,
      label: limitLabel(window, limits.overage),
      level,
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
export function noLimitsWords(response: Pick<ClaudeLimitsResponse, 'liveSessions' | 'lastSessionAt'>, now: Date): string {
  if (response.liveSessions > 0) {
    return `No limit data yet: ${countOf(response.liveSessions, 'Claude session is', 'Claude sessions are')} running, but none has answered a measurement.`;
  }
  if (response.lastSessionAt) {
    return `No limit data yet: the last Claude session ended ${dateTimeLabel(response.lastSessionAt, now)}; the next run measures them.`;
  }

  return 'No limit data yet: no Claude session has run since the app started; the next run measures them.';
}

// The note over the rows (or in their place) when the last round of
// measuring brought nothing: whose limits, when it failed and what the
// source said.
export function failureWords(account: 'Claude' | 'Codex', failure: LimitFailureView, now: Date): string {
  return `Couldn’t measure the ${account} limits ${dateTimeLabel(failure.at, now)}: ${failure.message}`;
}

export const UNAVAILABLE_WORDS = 'Plan limits are not available for this account: it runs on an API key or a cloud provider, or its login lacks the profile scope.';
export const NO_WINDOWS_WORDS = 'The plan reported no windows with a percentage.';

// ---------------------------------------------------------------------------
// The plan of a group's header: "Max plan", "Pro Lite plan"; nothing when
// the account did not say.

const PLAN_NAMES: Record<string, string> = {
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
  enterprise: 'Enterprise',
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  prolite: 'Pro Lite',
  business: 'Business',
  edu: 'Edu',
  edu_plus: 'Edu Plus',
  edu_pro: 'Edu Pro',
};

export function planWords(plan: string | null): string | null {
  if (plan === null || plan === '') {
    return null;
  }

  const name = PLAN_NAMES[plan] ?? plan.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return `${name} plan`;
}

// ---------------------------------------------------------------------------
// Codex: the account's windows as rows, the footer, the refusal.

// "7 days", "5 hours", "90 minutes" by the window's length; "window" when
// the backend did not say; the bucket's name after it when there are
// several.
export function codexWindowTitle(window: Pick<CodexLimitWindowView, 'windowMinutes' | 'bucket'>): string {
  const minutes = window.windowMinutes;
  let title = 'window';

  if (minutes !== null && minutes > 0) {
    if (minutes % 1440 === 0) {
      title = countOf(minutes / 1440, 'day');
    } else if (minutes % 60 === 0) {
      title = countOf(minutes / 60, 'hour');
    } else {
      title = countOf(minutes, 'minute');
    }
  }

  return window.bucket === null ? title : `${title} · ${window.bucket}`;
}

export function codexRows(limits: CodexLimitsView, now: Date): LimitRow[] {
  return limits.windows.map(window => {
    const state = { utilization: window.utilization, status: null };

    return {
      key: `codex:${window.bucket ?? ''}:${window.kind}`,
      title: codexWindowTitle(window),
      meta: resetWords(window.resetsAt, now),
      value: window.utilization,
      label: limitLabel(state, null),
      level: limitLevel(state),
    };
  });
}

const REACHED_WORDS: Record<string, string> = {
  rate_limit_reached: 'the rate limit is reached',
  workspace_owner_credits_depleted: 'the workspace owner’s credits are depleted',
  workspace_member_credits_depleted: 'the workspace member’s credits are depleted',
  workspace_owner_usage_limit_reached: 'the workspace owner’s usage limit is reached',
  workspace_member_usage_limit_reached: 'the workspace member’s usage limit is reached',
};

// The notes when the backend is refusing requests: one per bucket that
// is, in its terms — "Codex is refusing requests: the rate limit is
// reached.", and on a plan that meters several limits, "Codex is refusing
// requests against Other models: …"; none while they go through.
export function codexReachedWords(limits: Pick<CodexLimitsView, 'buckets'>): string[] {
  const notes: string[] = [];

  for (const bucket of limits.buckets) {
    const against = bucket.bucket === null ? '' : ` against ${bucket.bucket}`;

    if (bucket.reached !== null) {
      notes.push(`Codex is refusing requests${against}: ${REACHED_WORDS[bucket.reached] ?? bucket.reached.replace(/_/g, ' ')}.`);
    } else if (bucket.spendControlReached === true) {
      notes.push(`Codex is refusing requests${against}: the spend control is reached.`);
    }
  }

  return notes;
}

// "spend limit $80 of $100 (20% left, resets Wed, 10:00 · in 3d 17h)",
// named by its bucket when there are several.
function spendLimitWords(bucket: CodexBucketView, now: Date): string | null {
  const { spendLimit } = bucket;

  if (!spendLimit) {
    return null;
  }

  const words = `spend limit ${spendLimit.used} of ${spendLimit.limit} (${spendLimit.remainingPercent}% left, ${resetWords(spendLimit.resetsAt, now)})`;

  return bucket.bucket === null ? words : `${bucket.bucket}: ${words}`;
}

// The footer: when the measurement was taken, the credits as the backend
// states them, the member's spend limit of each bucket that has one, the
// reset credits — "measured 16:31 · no extra credits · 3 reset credits
// available".
export function codexMeasuredWords(limits: CodexLimitsView, now: Date): string {
  const parts = [`measured ${dateTimeLabel(limits.measuredAt, now)}`];
  const { credits } = limits;

  if (credits) {
    if (credits.unlimited) {
      parts.push('unlimited credits');
    } else if (credits.has) {
      parts.push(credits.balance !== null ? `credits: ${credits.balance}` : 'credits available');
    } else {
      parts.push('no extra credits');
    }
  }

  for (const bucket of limits.buckets) {
    const spend = spendLimitWords(bucket, now);

    if (spend) {
      parts.push(spend);
    }
  }

  if (limits.resetCredits !== null && limits.resetCredits > 0) {
    parts.push(`${countOf(limits.resetCredits, 'reset credit')} available`);
  }

  return parts.join(' · ');
}

export const NO_CODEX_LIMITS_WORDS = 'No Codex limit data yet: the CLI’s app-server has not answered a measurement; the next refresh asks again.';
// The server of an older build answers the limits in another shape (the
// console bundle goes live before the app restarts).
export const OLDER_SERVER_WORDS = 'The server runs an older build and answers the limits in another shape; the card fills in after the app restarts.';

// Whether the answer is of this build's contract: both accounts present,
// the Codex view (when there is one) with its buckets. Anything else is
// the server of an older build — a note, not a crash.
export function isCurrentLimitsShape(data: unknown): data is LimitsResponse {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const partial = data as Partial<LimitsResponse>;

  if (partial.claude === undefined || partial.codex === undefined) {
    return false;
  }

  const codex = partial.codex.limits;

  return codex === null || Array.isArray((codex as Partial<CodexLimitsView>).buckets);
}
export const NO_CODEX_WINDOWS_WORDS = 'The plan reported no rate-limit windows.';
