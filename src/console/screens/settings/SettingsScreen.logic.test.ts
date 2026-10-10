import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { browserWords, factsStage, loginSourceWords, sessionWords, telegramWords, timezoneWords } from './SettingsScreen.logic.ts';

const NOW = new Date(2026, 9, 10, 16, 38); // October 10, local

describe('settings screen rules', () => {
  it('reads the browser and the platform out of a User-Agent', () => {
    assert.equal(browserWords('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'), 'Chrome, macOS');
    assert.equal(browserWords('Mozilla/5.0 (iPhone; CPU iPhone OS 26_7_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0.8037.55 Mobile/15E148 Safari/604.1'), 'Chrome, iPhone');
    assert.equal(browserWords('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari, iPhone');
    assert.equal(browserWords('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'), 'Edge, Windows');
    assert.equal(browserWords('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'), 'Firefox, Linux');
    assert.equal(browserWords('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36'), 'Chrome, Android');
    assert.equal(browserWords('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36'), 'Headless Chrome, Linux');
    assert.equal(browserWords('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 YaBrowser/25.8.0.0 Safari/537.36'), 'Yandex Browser, Windows');
  });

  it('leaves out the part a User-Agent does not tell, and is null for one that tells nothing', () => {
    assert.equal(browserWords('curl/8.5.0'), null);
    assert.equal(browserWords(''), null);
    assert.equal(browserWords('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'), 'Linux');
    assert.equal(browserWords('SomeBot/1.0 Chrome/1.0'), 'Chrome');
  });

  it('names where the code came from', () => {
    assert.equal(loginSourceWords('telegram'), 'code from Telegram');
    assert.equal(loginSourceWords('console'), 'code from the server log');
    assert.equal(loginSourceWords(null), null);
  });

  it('lines up the session row: the moment, the browser, the source — the parts the facts give', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

    assert.equal(sessionWords({ createdAt: new Date(2026, 9, 5, 10, 24), userAgent: ua, loginSource: 'telegram' }, NOW), 'signed in Oct 5, 10:24 · Chrome, macOS · code from Telegram');
    assert.equal(sessionWords({ createdAt: new Date(2026, 9, 10, 9, 3), userAgent: '', loginSource: null }, NOW), 'signed in 09:03');
    assert.equal(sessionWords({ createdAt: new Date(2025, 11, 31, 23, 59), userAgent: 'curl/8', loginSource: 'console' }, NOW), 'signed in Dec 31, 2025, 23:59 · code from the server log');
  });

  it('names the time zone with its offset now and the clock there', () => {
    const summer = new Date(Date.UTC(2026, 6, 1, 12, 0));
    const winter = new Date(Date.UTC(2026, 0, 1, 12, 0));

    assert.deepEqual(timezoneWords('Europe/Moscow', summer), { value: 'Europe/Moscow · UTC+3', clock: 'It’s 15:00 there now.' });
    assert.deepEqual(timezoneWords('Asia/Jerusalem', summer), { value: 'Asia/Jerusalem · UTC+3', clock: 'It’s 15:00 there now.' });
    assert.deepEqual(timezoneWords('Asia/Jerusalem', winter), { value: 'Asia/Jerusalem · UTC+2', clock: 'It’s 14:00 there now.' });
    assert.deepEqual(timezoneWords('America/New_York', winter), { value: 'America/New_York · UTC-5', clock: 'It’s 07:00 there now.' });
    assert.deepEqual(timezoneWords('Asia/Kolkata', winter), { value: 'Asia/Kolkata · UTC+5:30', clock: 'It’s 17:30 there now.' });
    assert.deepEqual(timezoneWords('Europe/London', winter), { value: 'Europe/London · UTC', clock: 'It’s 12:00 there now.' });
    assert.deepEqual(timezoneWords('UTC', winter), { value: 'UTC', clock: 'It’s 12:00 there now.' });
  });

  it('shows a zone the browser does not know by its name alone', () => {
    assert.deepEqual(timezoneWords('Mars/Olympus_Mons', NOW), { value: 'Mars/Olympus_Mons', clock: null });
  });

  it('words the Telegram row: the title above, the kind, the chat id and the binding’s day below', () => {
    const linkedAt = new Date(2026, 7, 12, 22, 44);

    assert.deepEqual(telegramWords({ chatId: -1002183344120n, title: 'Balabash · personal', linkedAt }, NOW), { title: 'Balabash · personal', kind: 'Telegram group', chatId: '-1002183344120', linked: 'linked Aug 12' });
    // No title (the channel is off, the Bot API failed): the kind is the
    // title and is not repeated below.
    assert.deepEqual(telegramWords({ chatId: -5254371562n, title: null, linkedAt: new Date(2025, 7, 12) }, NOW), { title: 'Telegram group', kind: null, chatId: '-5254371562', linked: 'linked Aug 12, 2025' });
  });

  it('stages the facts query: the skeleton, the failure, the facts — and a failed refetch over kept facts is stale, not fresh', () => {
    const facts = { scheduleTimezone: 'UTC' };
    const failure = new Error('Internal error');

    // The course of a tab: the first read in flight, its failure, Retry
    // succeeding, a refetch failing over the kept facts, Retry succeeding.
    assert.deepEqual(factsStage({ data: undefined, error: null }), { kind: 'loading' });
    assert.deepEqual(factsStage({ data: undefined, error: failure }), { kind: 'failed', error: failure });
    assert.deepEqual(factsStage({ data: facts, error: null }), { kind: 'facts', data: facts, stale: null });
    assert.deepEqual(factsStage({ data: facts, error: failure }), { kind: 'facts', data: facts, stale: failure });
    assert.deepEqual(factsStage({ data: facts, error: null }), { kind: 'facts', data: facts, stale: null });
  });
});
