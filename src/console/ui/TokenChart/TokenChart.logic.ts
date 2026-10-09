// The token chart's pure rules (design: TokenChart, spec
// design/main-thread-token-chart.md): what each model request was made of.
// Two panels on one request axis, each on its own scale — input = cached
// (read from the prompt cache) + cache write + uncached, output = text +
// reasoning; the column height is the total. The requests of one turn stand
// close, a new turn starts after a wider gap; every hour boundary is a
// hairline and, where there is room, the hour. The same rows feed the table
// view, newest first.

export type TokenRequestKind = 'turn' | 'keepalive' | 'failed';
export type TokenVerdict = 'hit' | 'expired' | 'miss';

export type TokenRequest = {
  // The request's identity: keeps the selection on the same request when
  // the window moves.
  id: string;
  // When the request completed (the row is written after the call).
  at: Date;
  kind: TokenRequestKind;
  // The request's number within its turn (1..N); null reads as 1.
  iteration: number | null;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  durationMs: number | null;
  // The server's prompt-cache verdict; null — not reported.
  verdict: TokenVerdict | null;
  missReason: string | null;
  // The error of a failed request.
  error: string | null;
};

export type TokenSeries = 'cached' | 'write' | 'fresh' | 'out' | 'reason';

// A stacked part: its height as a percentage of the panel's top ("12.34%");
// top — the uppermost part, rounded.
export type TokenSeg = { s: TokenSeries; v: string; top: boolean };

export type TokenDetailRow = {
  s?: TokenSeries;
  // The Input / Output total line of the group.
  group?: boolean;
  label: string;
  value: string;
  share: string;
};

export type TokenDetail = {
  title: string;
  sub: string;
  sub2: string;
  ok: boolean;
  rows: TokenDetailRow[];
  note: string;
  error: string;
};

export type TokenColumn = {
  key: string;
  // The first column: no gap on the left.
  first: boolean;
  // A wider gap: the first request of a turn, a ping, a failed request.
  turnStart: boolean;
  // An hour boundary before this column: a hairline; label — the hour under
  // it, or '' when a label stood too close.
  hour: boolean;
  label: string;
  // The label ends at the hairline instead of starting there: a column near
  // the right edge, where a label starting at its line would run past the
  // plot and widen the scroll area.
  tail: boolean;
  // The tooltip opens to the left: a column in the right part of the plot
  // (the component measures the visible part when the plot scrolls).
  flip: boolean;
  aria: string;
  segIn: TokenSeg[];
  segOut: TokenSeg[];
  keepalive: boolean;
  failed: boolean;
  detail: TokenDetail;
};

export type TokenAxisTick = { label: string; p: string };
export type TokenLegendKey = { s: TokenSeries; label: string; value: string; share: string };

export type TokenChartModel = {
  cols: TokenColumn[];
  yIn: TokenAxisTick[];
  yOut: TokenAxisTick[];
  // The widest label of each axis: holds the axis column's width.
  yInWidest: string;
  yOutWidest: string;
  inHead: string;
  outHead: string;
  keysIn: TokenLegendKey[];
  keysOut: TokenLegendKey[];
  requests: number;
  pings: number;
  failures: number;
  aria: string;
};

export type TokenTableRow = {
  key: string;
  time: string;
  kind: string;
  input: string;
  cached: string;
  write: string;
  fresh: string;
  output: string;
  reasoning: string;
  duration: string;
};

// "1,234" — the exact count.
export function exact(n: number): string {
  return n.toLocaleString('en-US');
}

// "1.23M", "123k", "1.5k", "512" — a count in the legend and on the axis.
export function shortTokens(n: number): string {
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(2)}M`;
  }
  if (n >= 1e5) {
    return `${Math.round(n / 1e3)}k`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  }

  return String(n);
}

// "62%", "<1%" — the share of a part in its total; '' without a total.
export function share(part: number, total: number): string {
  if (!total) {
    return '';
  }
  if (part > 0 && part / total < 0.01) {
    return '<1%';
  }

  return `${Math.round((part / total) * 100)}%`;
}

// "42s", "18m", "2m 15s" (seconds up to ten minutes), "1h 05m" — the idle
// time before a request.
export function idleLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));

  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    const rest = s % 60;

    return `${Math.floor(s / 60)}m${rest && s < 600 ? ` ${rest}s` : ''}`;
  }

  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

// "6.1 s" — a request's duration.
export function secondsLabel(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// "14:41:51" — the time of a request to the second; on another day than
// now — "Oct 8, 23:10:05".
export function requestTime(at: Date, now: Date): string {
  const time = at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

  if (sameDay(at, now)) {
    return time;
  }

  const day = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });

  return `${day}, ${time}`;
}

// The y scale: 0..top with a 1 / 2 / 2.5 / 5 step and about `parts`
// intervals; the step is a token at least (an empty window scales 0..1).
export function ticks(max: number, parts: number): number[] {
  const rough = Math.max(max, 1) / parts;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const n = rough / magnitude;
  const step = Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * magnitude);
  const top = Math.max(Math.ceil(max / step), 1) * step;
  const out: number[] = [];

  for (let v = 0; v <= top + step / 2; v += step) {
    out.push(v);
  }

  return out;
}

function axis(values: number[]): TokenAxisTick[] {
  const top = values[values.length - 1];

  return values.map(v => ({ label: shortTokens(v), p: `${(v / top) * 100}%` }));
}

function widest(values: number[]): string {
  return values.map(shortTokens).reduce((a, b) => (b.length > a.length ? b : a), '');
}

const VERDICT: Record<TokenVerdict, string> = {
  hit: 'Server cache verdict: hit',
  expired: 'Server cache verdict: previous response expired',
  miss: 'Server cache verdict: miss',
};

function verdictNote(request: TokenRequest): string {
  if (!request.verdict) {
    return '';
  }

  return request.verdict === 'miss' && request.missReason ? `${VERDICT.miss} — ${request.missReason}` : VERDICT[request.verdict];
}

type Measured = TokenRequest & {
  ok: boolean;
  fresh: number;
  text: number;
  // Every request of a turn knows its turn's length: the requests of the
  // turn in the window, or the highest number among them when the window
  // begins inside the turn.
  turnStart: boolean;
  n: number;
};

// A turn: consecutive turn requests numbered 1, 2, 3…; a ping or a failed
// request stands alone, and a turn request numbered 2+ after one joins the
// turn before it. The first turn of the window may begin before the window
// does: its length is then the highest number seen, never less than the
// number of a request.
function measure(reqs: TokenRequest[]): Measured[] {
  const rows: Measured[] = reqs.map(q => ({
    ...q,
    ok: q.kind !== 'failed',
    fresh: Math.max(0, q.input - q.cached - q.cacheWrite),
    text: Math.max(0, q.output - q.reasoning),
    turnStart: false,
    n: 1,
  }));
  const length = new Map<number, number>();
  const highest = new Map<number, number>();
  const group: number[] = [];
  let start = -1;

  rows.forEach((q, j) => {
    q.turnStart = q.kind !== 'turn' || (q.iteration ?? 1) === 1 || j === 0;

    if (q.kind === 'turn' && q.turnStart) {
      start = j;
    }

    group[j] = q.kind === 'turn' ? start : -1;

    if (group[j] >= 0) {
      length.set(group[j], (length.get(group[j]) ?? 0) + 1);
      highest.set(group[j], Math.max(highest.get(group[j]) ?? 1, q.iteration ?? 1));
    }
  });
  rows.forEach((q, j) => {
    q.n = group[j] >= 0 ? Math.max(length.get(group[j]) ?? 1, highest.get(group[j]) ?? 1) : 1;
  });

  return rows;
}

function kindLabel(q: Measured): string {
  return q.kind === 'keepalive' ? 'keepalive ping' : q.kind === 'failed' ? 'failed request' : `turn · request ${q.iteration ?? 1} of ${q.n}`;
}

function segments(parts: [TokenSeries, number][], top: number): TokenSeg[] {
  const list = parts.filter(([, v]) => v > 0).map(([s, v]) => ({ s, v: `${((v / top) * 100).toFixed(2)}%`, top: false }));

  if (list.length) {
    list[list.length - 1].top = true;
  }

  return list;
}

// The idle time before a request: from the previous request's completion to
// this one's start — `at` is the completion, so the call's own duration is
// taken out (a request without a duration counts from its completion).
export function idleBefore(q: Pick<TokenRequest, 'at' | 'durationMs'>, prev: Pick<TokenRequest, 'at'>): number {
  return q.at.getTime() - (q.durationMs ?? 0) - prev.at.getTime();
}

function detailOf(q: Measured, prev: Measured | undefined, now: Date): TokenDetail {
  const idle = prev ? idleBefore(q, prev) : 0;
  const sub2 = [prev && idle >= 60_000 ? `after ${idleLabel(idle)} idle` : '', q.durationMs ? secondsLabel(q.durationMs) : ''].filter(Boolean).join(' · ');
  const rows: TokenDetailRow[] = q.ok
    ? [
        { group: true, label: 'Input', value: exact(q.input), share: '' },
        { s: 'cached', label: 'cached', value: exact(q.cached), share: share(q.cached, q.input) },
        { s: 'write', label: 'cache write', value: exact(q.cacheWrite), share: share(q.cacheWrite, q.input) },
        { s: 'fresh', label: 'uncached', value: exact(q.fresh), share: share(q.fresh, q.input) },
        { group: true, label: 'Output', value: exact(q.output), share: '' },
        { s: 'out', label: 'text', value: exact(q.text), share: '' },
        { s: 'reason', label: 'reasoning', value: exact(q.reasoning), share: '' },
      ]
    : [];

  return {
    title: requestTime(q.at, now),
    sub: kindLabel(q),
    sub2,
    ok: q.ok,
    rows,
    note: q.ok ? verdictNote(q) : '',
    error: q.ok ? '' : q.error || 'request failed',
  };
}

// The local day and hour a request falls into.
function hourKey(at: Date): string {
  return `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}-${at.getHours()}`;
}

// A label is skipped when closer than this many columns to the previous
// one; the hairline stays.
const LABEL_GAP = 4;
// Columns past this share of the plot open their tooltip to the left.
const FLIP_AT = 0.62;
// The last columns whose hour label ends at the hairline: eight slots of
// the narrowest width hold a label.
const LABEL_TAIL = 8;

export function buildTokenChart(reqs: TokenRequest[], now: Date): TokenChartModel {
  const rows = measure(reqs);
  const ok = rows.filter(q => q.ok);
  const sum = (pick: (q: Measured) => number) => ok.reduce((a, q) => a + pick(q), 0);
  const input = sum(q => q.input);
  const cached = sum(q => q.cached);
  const write = sum(q => q.cacheWrite);
  const fresh = sum(q => q.fresh);
  const output = sum(q => q.output);
  const reasoning = sum(q => q.reasoning);
  const text = sum(q => q.text);
  const yInValues = ticks(Math.max(0, ...ok.map(q => q.input)), 3);
  const yOutValues = ticks(Math.max(0, ...ok.map(q => q.output)), 2);
  const topIn = yInValues[yInValues.length - 1];
  const topOut = yOutValues[yOutValues.length - 1];
  let lastLabel = -LABEL_GAP;
  let lastHour: string | null = null;

  const cols = rows.map((q, j): TokenColumn => {
    const hour = hourKey(q.at);
    let boundary = false;
    let label = '';

    if (lastHour !== null && hour !== lastHour) {
      boundary = true;

      if (j - lastLabel >= LABEL_GAP) {
        label = `${String(q.at.getHours()).padStart(2, '0')}:00`;
        lastLabel = j;
      }
    }
    lastHour = hour;

    return {
      key: q.id,
      first: j === 0,
      turnStart: j > 0 && q.turnStart,
      hour: boundary,
      label,
      tail: j >= rows.length - LABEL_TAIL,
      flip: j > rows.length * FLIP_AT,
      aria: `${requestTime(q.at, now)}, ${q.ok ? `input ${exact(q.input)}, cached ${exact(q.cached)}, output ${exact(q.output)}` : 'failed'}`,
      segIn: q.ok ? segments([['cached', q.cached], ['write', q.cacheWrite], ['fresh', q.fresh]], topIn) : [],
      segOut: q.ok ? segments([['reason', q.reasoning], ['out', q.text]], topOut) : [],
      keepalive: q.kind === 'keepalive',
      failed: !q.ok,
      detail: detailOf(q, rows[j - 1], now),
    };
  });

  const fromCache = share(cached, input);

  return {
    cols,
    yIn: axis(yInValues),
    yOut: axis(yOutValues),
    yInWidest: widest(yInValues),
    yOutWidest: widest(yOutValues),
    inHead: `${shortTokens(input)} · ${fromCache || '0%'} read from cache`,
    outHead: shortTokens(output),
    keysIn: [
      { s: 'cached', label: 'cached', value: shortTokens(cached), share: share(cached, input) },
      { s: 'write', label: 'cache write', value: shortTokens(write), share: share(write, input) },
      { s: 'fresh', label: 'uncached', value: shortTokens(fresh), share: share(fresh, input) },
    ],
    keysOut: [
      { s: 'out', label: 'text', value: shortTokens(text), share: '' },
      { s: 'reason', label: 'reasoning', value: shortTokens(reasoning), share: '' },
    ],
    requests: rows.length,
    pings: rows.filter(q => q.kind === 'keepalive').length,
    failures: rows.filter(q => !q.ok).length,
    aria: `Tokens per request, ${rows.length} requests: input ${shortTokens(input)}, ${fromCache || '0%'} read from cache, ${share(write, input) || '0%'} written to cache; output ${shortTokens(output)}`,
  };
}

// The table view: the same requests, newest first; a failed request has
// dashes for its counts.
export function tokenTableRows(reqs: TokenRequest[], now: Date): TokenTableRow[] {
  const dash = (q: Measured, value: number) => (q.ok ? exact(value) : '—');

  return measure(reqs)
    .map(q => ({
      key: q.id,
      time: requestTime(q.at, now),
      kind: q.kind === 'turn' ? `turn · ${q.iteration ?? 1}/${q.n}` : q.kind,
      input: dash(q, q.input),
      cached: dash(q, q.cached),
      write: dash(q, q.cacheWrite),
      fresh: dash(q, q.fresh),
      output: dash(q, q.output),
      reasoning: dash(q, q.reasoning),
      duration: q.durationMs ? secondsLabel(q.durationMs) : '—',
    }))
    .reverse();
}
