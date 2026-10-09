// Formatting helpers shared by ui/, features/ and screens: English plural
// forms, counts, times of day, day labels, durations — the wording of the
// design's rows ("since 14:02", "running 2h 36m", "13:17 → 13:59", "Today,
// October 9"). Dates render in the browser's locale time zone; the words
// are English, like the rest of the interface.

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return n === 1 ? one : many;
}

// "4 threads", "1 thread" — count and noun together.
export function countOf(n: number, one: string, many?: string): string {
  return `${n.toLocaleString('en-US')} ${plural(n, one, many)}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// "14:02" — the time of day, 24-hour clock.
export function timeOfDay(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

// "Oct 7" / "Oct 7, 2025" — a short date, the year only when it differs from now.
export function shortDate(date: Date, now: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

// The local calendar day as a key: "2026-10-09".
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Whole local days from `date` to `now` (0 — today, 1 — yesterday).
function daysAgo(date: Date, now: Date): number {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  return Math.round((start(now) - start(date)) / DAY);
}

// A day divider: "Today, October 9", "Yesterday, October 8", "Monday,
// October 5" within the week, then "September 24" and, in another year,
// "September 24, 2025".
export function dayLabel(date: Date, now: Date): string {
  const ago = daysAgo(date, now);
  const monthDay = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  if (ago === 0) {
    return `Today, ${monthDay}`;
  }
  if (ago === 1) {
    return `Yesterday, ${monthDay}`;
  }
  if (ago > 1 && ago < 7) {
    return `${date.toLocaleDateString('en-US', { weekday: 'long' })}, ${monthDay}`;
  }

  return date.getFullYear() === now.getFullYear() ? monthDay : `${monthDay}, ${date.getFullYear()}`;
}

// "since 14:02" today, "since Oct 7, 14:02" on another day.
export function sinceLabel(date: Date, now: Date): string {
  return sameDay(date, now) ? `since ${timeOfDay(date)}` : `since ${shortDate(date, now)}, ${timeOfDay(date)}`;
}

// "13:17 → 13:59"; an end on another day names it: "23:10 → Oct 8, 00:14".
export function rangeLabel(start: Date, end: Date, now: Date): string {
  return sameDay(start, end) ? `${timeOfDay(start)} → ${timeOfDay(end)}` : `${timeOfDay(start)} → ${shortDate(end, now)}, ${timeOfDay(end)}`;
}

// "<1m", "22m", "2h 36m", "3d 4h".
export function durationLabel(ms: number): string {
  const total = Math.max(0, ms);

  if (total < MINUTE) {
    return '<1m';
  }
  if (total < HOUR) {
    return `${Math.floor(total / MINUTE)}m`;
  }
  if (total < DAY) {
    const hours = Math.floor(total / HOUR);
    const minutes = Math.floor((total % HOUR) / MINUTE);

    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }

  const days = Math.floor(total / DAY);
  const hours = Math.floor((total % DAY) / HOUR);

  return `${days}d ${hours}h`;
}

// "14:02" today, "Oct 7, 14:02" on another day — the time of a feed item.
export function dateTimeLabel(date: Date, now: Date): string {
  return sameDay(date, now) ? timeOfDay(date) : `${shortDate(date, now)}, ${timeOfDay(date)}`;
}

// "today, 14:02" / "Oct 7, 13:17" — a point in time in a sentence.
export function startedLabel(date: Date, now: Date): string {
  return sameDay(date, now) ? `today, ${timeOfDay(date)}` : `${shortDate(date, now)}, ${timeOfDay(date)}`;
}

// "512 B", "4.2 KiB", "1.5 MiB" — binary units, one decimal above bytes.
export function fileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.max(0, Math.round(bytes))} B`;
  }

  const kib = bytes / 1024;

  if (kib < 1024) {
    return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KiB`;
  }

  const mib = kib / 1024;

  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MiB`;
}
