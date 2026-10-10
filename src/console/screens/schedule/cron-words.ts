// A cron expression spelled out — "daily at 4:00", "every 30 minutes",
// "weekdays at 9:00", "Mondays at 10:00" — for the shapes a person writes;
// null for a shape these words do not cover (the screen then shows the
// expression alone, and the next run says what it means). Five fields:
// minute, hour, day of month, month, day of week; names of days and
// months as croner reads them. Pure, tested.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ALIASES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_ALIASES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// One field read as a set of values; 'any' for *, a step for */n and a-b/n.
type Field = { kind: 'any' } | { kind: 'list'; values: number[] } | { kind: 'step'; every: number; from: number | null; to: number | null };

function number(text: string, aliases: Record<string, number>): number | null {
  const alias = aliases[text.toLowerCase()];

  if (alias !== undefined) {
    return alias;
  }

  return /^\d+$/.test(text) ? Number(text) : null;
}

function parseField(text: string, aliases: Record<string, number> = {}): Field | null {
  if (text === '*') {
    return { kind: 'any' };
  }

  const step = /^(\*|[^/]+)\/(\d+)$/.exec(text);

  if (step) {
    const every = Number(step[2]);

    if (every < 1) {
      return null;
    }

    if (step[1] === '*') {
      return { kind: 'step', every, from: null, to: null };
    }

    const range = /^([^-]+)-([^-]+)$/.exec(step[1]!);

    if (!range) {
      return null;
    }

    const from = number(range[1]!, aliases);
    const to = number(range[2]!, aliases);

    return from === null || to === null ? null : { kind: 'step', every, from, to };
  }

  const values: number[] = [];

  for (const part of text.split(',')) {
    const range = /^([^-]+)-([^-]+)$/.exec(part);

    if (range) {
      const from = number(range[1]!, aliases);
      const to = number(range[2]!, aliases);

      if (from === null || to === null || to < from) {
        return null;
      }

      for (let value = from; value <= to; value += 1) {
        values.push(value);
      }
    } else {
      const value = number(part, aliases);

      if (value === null) {
        return null;
      }

      values.push(value);
    }
  }

  return { kind: 'list', values: [...new Set(values)].sort((a, b) => a - b) };
}

// "4:00", "9:30" — a time of day without a leading zero on the hour.
export function clockWords(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, '0')}`;
}

function listWords(words: string[]): string {
  if (words.length <= 1) {
    return words.join('');
  }

  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function daysWords(values: number[]): string | null {
  const days = values.map(value => (value === 7 ? 0 : value));

  if (days.some(day => day < 0 || day > 6)) {
    return null;
  }

  const set = [...new Set(days)].sort((a, b) => a - b);
  const key = set.join(',');

  if (key === '1,2,3,4,5') {
    return 'weekdays';
  }

  if (key === '0,6') {
    return 'weekends';
  }

  if (key === '0,1,2,3,4,5,6') {
    return 'daily';
  }

  if (set.length === 1) {
    return `${DAY_NAMES[set[0]!]}s`;
  }

  return listWords(set.map(day => DAY_SHORT[day]!));
}

function ordinal(day: number): string {
  const rest = day % 100;
  const suffix = rest >= 11 && rest <= 13 ? 'th' : day % 10 === 1 ? 'st' : day % 10 === 2 ? 'nd' : day % 10 === 3 ? 'rd' : 'th';

  return `${day}${suffix}`;
}

export function cronWords(expression: string): string | null {
  const parts = expression.trim().split(/\s+/);

  if (parts.length !== 5) {
    return null;
  }

  const minute = parseField(parts[0]!);
  const hour = parseField(parts[1]!);
  const dom = parseField(parts[2]!);
  const month = parseField(parts[3]!, MONTH_ALIASES);
  const dow = parseField(parts[4]!, DAY_ALIASES);

  if (!minute || !hour || !dom || !month || !dow) {
    return null;
  }

  // Every N minutes / every minute: the hour is open, the days are open.
  if (hour.kind === 'any' && dom.kind === 'any' && month.kind === 'any' && dow.kind === 'any') {
    if (minute.kind === 'any') {
      return 'every minute';
    }

    // A step that does not divide the hour restarts at :00 — the last gap
    // is shorter, so "every N minutes" would be untrue.
    if (minute.kind === 'step' && minute.from === null) {
      return minute.every === 1 ? 'every minute' : 60 % minute.every === 0 ? `every ${minute.every} minutes` : null;
    }

    if (minute.kind === 'list' && minute.values.length === 1) {
      return minute.values[0] === 0 ? 'every hour' : `hourly at :${String(minute.values[0]).padStart(2, '0')}`;
    }

    return null;
  }

  // Every N hours (at a minute), with or without an hour range.
  if (hour.kind === 'step' && minute.kind === 'list' && minute.values.length === 1 && dom.kind === 'any' && month.kind === 'any' && dow.kind === 'any') {
    const at = minute.values[0]!;
    const atWords = at === 0 ? '' : ` at :${String(at).padStart(2, '0')}`;
    const everyWords = hour.every === 1 ? 'every hour' : `every ${hour.every} hours`;

    // Over the whole day the step restarts at midnight: only a step that
    // divides the day is "every N hours". Within a range the words name
    // the first and the last hour the step reaches, and the gap to the next
    // day is theirs to tell.
    if (hour.from === null) {
      return 24 % hour.every === 0 ? `${everyWords}${atWords}` : null;
    }

    const to = hour.to ?? hour.from;

    if (hour.from > 23 || to > 23 || to < hour.from) {
      return null;
    }

    const last = hour.from + Math.floor((to - hour.from) / hour.every) * hour.every;

    return `${everyWords}${atWords} from ${clockWords(hour.from, at)} to ${clockWords(last, at)}`;
  }

  // Fixed times of day.
  if (minute.kind !== 'list' || hour.kind !== 'list' || minute.values.length !== 1) {
    return null;
  }

  const at = minute.values[0]!;

  if (at > 59 || hour.values.some(value => value > 23)) {
    return null;
  }

  const times = listWords(hour.values.map(value => clockWords(value, at)));

  if (dom.kind === 'any' && month.kind === 'any') {
    if (dow.kind === 'any') {
      return `daily at ${times}`;
    }

    if (dow.kind === 'list') {
      const days = daysWords(dow.values);

      return days ? `${days} at ${times}` : null;
    }

    return null;
  }

  if (dow.kind !== 'any' || dom.kind !== 'list' || dom.values.length !== 1) {
    return null;
  }

  const day = dom.values[0]!;

  if (day < 1 || day > 31) {
    return null;
  }

  if (month.kind === 'any') {
    return `monthly on the ${ordinal(day)} at ${times}`;
  }

  if (month.kind === 'list' && month.values.length === 1) {
    const name = MONTH_SHORT[month.values[0]! - 1];

    return name ? `yearly on ${name} ${day} at ${times}` : null;
  }

  return null;
}
