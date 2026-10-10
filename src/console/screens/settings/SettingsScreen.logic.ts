// The words of the Settings cards that read facts (GET /api/settings):
// the Telegram row, the time zone field, the session row. Pure — tested
// without the DOM.

import type { LoginSource, TelegramGroupView, WebSessionView } from '../../../api/contract.ts';
import { dateTimeLabel, shortDate } from '../../lib/format/index.ts';

// "Chrome, macOS" — the browser and the platform of a User-Agent, for the
// session row; a part the string does not tell is left out, a string that
// tells neither is null. A family's own token comes before the "Chrome"
// and "Safari" every WebKit/Blink browser also carries; iPadOS 13+ presents
// an iPad as a Mac and reads as one here.
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\//, 'Opera'],
  [/\bYaBrowser\//, 'Yandex Browser'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\bHeadlessChrome\//, 'Headless Chrome'],
  [/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const PLATFORMS: [RegExp, string][] = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b|\bX11\b/, 'Linux'],
];

function firstMatch(rules: [RegExp, string][], ua: string): string | null {
  for (const [rule, name] of rules) {
    if (rule.test(ua)) {
      return name;
    }
  }

  return null;
}

export function browserWords(userAgent: string): string | null {
  const parts = [firstMatch(BROWSERS, userAgent), firstMatch(PLATFORMS, userAgent)].filter((part): part is string => part !== null);

  return parts.length ? parts.join(', ') : null;
}

// "code from Telegram" / "code from the server log" — how this browser
// got in; nothing when the session predates the fact.
export function loginSourceWords(source: LoginSource | null): string | null {
  switch (source) {
    case 'telegram':
      return 'code from Telegram';
    case 'console':
      return 'code from the server log';
    default:
      return null;
  }
}

// "signed in Oct 5, 10:24 · Chrome, macOS · code from Telegram" — the
// session row's line, the parts the facts give.
export function sessionWords(session: Pick<WebSessionView, 'createdAt' | 'userAgent' | 'loginSource'>, now: Date): string {
  return [`signed in ${dateTimeLabel(session.createdAt, now)}`, browserWords(session.userAgent), loginSourceWords(session.loginSource)].filter(part => part !== null).join(' · ');
}

export type TimezoneWords = {
  // "Europe/Moscow · UTC+3" — the zone and its offset now; the zone alone
  // when the browser does not know it.
  value: string;
  // "It’s 16:38 there now." — the clock of the zone, for the hint; null
  // when the browser does not know the zone.
  clock: string | null;
};

// The offset of a zone at `now` as "UTC+3" / "UTC-4:30" / "UTC" — read
// from the browser's own tables (shortOffset gives "GMT+3", "GMT-4:30";
// at zero "GMT", "GMT+0" or "UTC" by the engine — all read "UTC").
function offsetWords(timeZone: string, now: Date): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(now).find(p => p.type === 'timeZoneName');
  const name = part?.value ?? 'GMT';

  return name.replace(/^GMT/, 'UTC').replace(/^UTC[+-]0(?::00)?$/, 'UTC');
}

export function timezoneWords(timeZone: string, now: Date): TimezoneWords {
  try {
    const clock = now.toLocaleTimeString('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const offset = offsetWords(timeZone, now);

    // "UTC · UTC" says nothing twice.
    return { value: offset === timeZone ? timeZone : `${timeZone} · ${offset}`, clock: `It’s ${clock} there now.` };
  } catch {
    // A zone the browser has no tables for (RangeError): the name alone.
    return { value: timeZone, clock: null };
  }
}

export type TelegramWords = {
  // The group's title, or the kind of row when the title is unknown.
  title: string;
  // The parts of the row's line before the chat id: "Telegram group" when
  // the title stands above; nothing when the kind is already the title.
  kind: string | null;
  chatId: string;
  // "linked Aug 12"
  linked: string;
};

export function telegramWords(group: TelegramGroupView, now: Date): TelegramWords {
  return {
    title: group.title ?? 'Telegram group',
    kind: group.title === null ? null : 'Telegram group',
    chatId: String(group.chatId),
    linked: `linked ${shortDate(group.linkedAt, now)}`,
  };
}
