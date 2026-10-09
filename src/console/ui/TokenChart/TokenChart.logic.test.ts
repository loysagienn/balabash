import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTokenChart, idleLabel, requestTime, share, shortTokens, ticks, tokenTableRows } from './TokenChart.logic.ts';
import type { TokenRequest } from './TokenChart.logic.ts';

const at = (h: number, m: number, s = 0, day = 9) => new Date(2026, 9, day, h, m, s);
const NOW = at(16, 38);

function req(partial: Partial<TokenRequest> & { at: Date }): TokenRequest {
  return {
    kind: 'turn',
    iteration: 1,
    input: 40_000,
    cached: 30_000,
    cacheWrite: 1_000,
    output: 500,
    reasoning: 100,
    durationMs: 6_100,
    verdict: 'hit',
    missReason: null,
    error: null,
    ...partial,
  };
}

describe('token chart — numbers', () => {
  it('shortens counts, writes shares and idle times', () => {
    assert.equal(shortTokens(512), '512');
    assert.equal(shortTokens(1_500), '1.5k');
    assert.equal(shortTokens(42_000), '42k');
    assert.equal(shortTokens(123_456), '123k');
    assert.equal(shortTokens(1_234_567), '1.23M');
    assert.equal(share(30_000, 40_000), '75%');
    assert.equal(share(10, 40_000), '<1%');
    assert.equal(share(0, 40_000), '0%');
    assert.equal(share(5, 0), '');
    assert.equal(idleLabel(42_000), '42s');
    assert.equal(idleLabel(135_000), '2m 15s');
    assert.equal(idleLabel(18 * 60_000 + 20_000), '18m');
    assert.equal(idleLabel(65 * 60_000), '1h 05m');
  });

  it('scales the axis with a 1 / 2 / 2.5 / 5 step', () => {
    assert.deepEqual(ticks(45_861, 3), [0, 20_000, 40_000, 60_000]);
    assert.deepEqual(ticks(541, 2), [0, 500, 1000]);
    assert.deepEqual(ticks(7, 3), [0, 2.5, 5, 7.5]);
    assert.deepEqual(ticks(0, 2), [0, 1]);
    assert.deepEqual(ticks(1, 3), [0, 1]);
  });

  it('writes a request time to the second, with the day when it is not today', () => {
    assert.equal(requestTime(at(14, 41, 51), NOW), '14:41:51');
    assert.equal(requestTime(at(23, 10, 5, 8), NOW), 'Oct 8, 23:10:05');
    assert.equal(requestTime(new Date(2025, 9, 8, 23, 10, 5), NOW), 'Oct 8, 2025, 23:10:05');
  });
});

describe('token chart — columns', () => {
  const reqs: TokenRequest[] = [
    req({ at: at(9, 2, 11), cached: 0, cacheWrite: 37_643, input: 42_034, verdict: 'expired' }),
    req({ at: at(9, 21, 40), iteration: 1 }),
    req({ at: at(9, 21, 47), iteration: 2, output: 96, reasoning: 0, verdict: null }),
    req({ at: at(9, 21, 53), iteration: 3, output: 15, reasoning: 0, verdict: null }),
    req({ at: at(9, 54, 12), kind: 'keepalive', iteration: 1, output: 0, reasoning: 0, cacheWrite: 0, durationMs: 1_300 }),
    req({ at: at(10, 13, 2), iteration: 1 }),
    req({ at: at(10, 37, 20), kind: 'failed', input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, durationMs: 30_000, verdict: null, error: '502 Bad Gateway' }),
    req({ at: at(10, 37, 58), iteration: 1, verdict: 'miss', missReason: 'tools_changed' }),
  ];
  const model = buildTokenChart(reqs, NOW);

  it('groups the requests of a turn and marks the gaps', () => {
    const detail = model.cols.map(col => col.detail.sub);

    assert.deepEqual(detail, [
      'turn · request 1 of 1',
      'turn · request 1 of 3',
      'turn · request 2 of 3',
      'turn · request 3 of 3',
      'keepalive ping',
      'turn · request 1 of 1',
      'failed request',
      'turn · request 1 of 1',
    ]);
    assert.deepEqual(
      model.cols.map(col => col.turnStart),
      [false, true, false, false, true, true, true, true],
    );
    assert.equal(model.cols[0].first, true);
    assert.equal(model.cols[1].first, false);
  });

  it('draws an hour boundary as a hairline and labels it only where there is room', () => {
    assert.deepEqual(
      model.cols.map(col => col.hour),
      [false, false, false, false, false, true, false, false],
    );
    assert.deepEqual(
      model.cols.map(col => col.label),
      ['', '', '', '', '', '10:00', '', ''],
    );

    // Two boundaries three columns apart: the second keeps its hairline, not its label.
    const dense = buildTokenChart([req({ at: at(9, 59) }), req({ at: at(10, 1) }), req({ at: at(10, 2) }), req({ at: at(10, 3) }), req({ at: at(11, 1) })], NOW);

    assert.deepEqual(
      dense.cols.map(col => `${col.hour ? 'h' : '-'}${col.label}`),
      ['-', 'h10:00', '-', '-', 'h'],
    );

    // Midnight between two days is a boundary too, even at the same hour of the clock.
    const midnight = buildTokenChart([req({ at: at(10, 5, 0, 8) }), req({ at: at(10, 5, 0, 9) })], NOW);

    assert.equal(midnight.cols[1].hour, true);
    assert.equal(midnight.cols[1].label, '10:00');
  });

  it('stacks the parts bottom-up against the panel top, the uppermost one rounded', () => {
    const yIn = model.yIn.map(tick => tick.label);

    assert.deepEqual(yIn, ['0', '20k', '40k', '60k']);
    // Equal lengths: the first of them holds the width.
    assert.equal(model.yInWidest, '20k');
    assert.deepEqual(model.yOut.map(tick => tick.label), ['0', '250', '500']);
    // 42,034 input: cache write 37,643 then uncached 4,391 (no cached part).
    assert.deepEqual(model.cols[0].segIn, [
      { s: 'write', v: '62.74%', top: false },
      { s: 'fresh', v: '7.32%', top: true },
    ]);
    assert.deepEqual(model.cols[1].segOut, [
      { s: 'reason', v: '20.00%', top: false },
      { s: 'out', v: '80.00%', top: true },
    ]);
    assert.deepEqual(model.cols[6].segIn, []);
    assert.equal(model.cols[6].failed, true);
    assert.equal(model.cols[4].keepalive, true);
  });

  it('describes a request in the tooltip: idle time, duration, parts and the cache verdict', () => {
    const second = model.cols[1].detail;

    assert.equal(second.title, '09:21:40');
    assert.equal(second.sub2, 'after 19m idle · 6.1 s');
    assert.deepEqual(
      second.rows.map(row => `${row.group ? '*' : ''}${row.label} ${row.value}${row.share ? ` ${row.share}` : ''}`),
      ['*Input 40,000', 'cached 30,000 75%', 'cache write 1,000 3%', 'uncached 9,000 23%', '*Output 500', 'text 400', 'reasoning 100'],
    );
    assert.equal(second.note, 'Server cache verdict: hit');
    assert.equal(model.cols[0].detail.note, 'Server cache verdict: previous response expired');
    assert.equal(model.cols[0].detail.sub2, '6.1 s');
    assert.equal(model.cols[7].detail.note, 'Server cache verdict: miss — tools_changed');
    // Within a turn the requests follow within seconds: no idle line.
    assert.equal(model.cols[2].detail.sub2, '6.1 s');

    const failed = model.cols[6].detail;

    assert.equal(failed.ok, false);
    assert.equal(failed.error, '502 Bad Gateway');
    assert.deepEqual(failed.rows, []);
    assert.equal(failed.note, '');
  });

  it('sums the window in the legend and counts pings and failures', () => {
    // 7 completed requests: input 6 × 40,000 + 42,034 = 282,034; cached 6 × 30,000; writes 5 × 1,000 + 37,643.
    assert.equal(model.inHead, '282k · 64% read from cache');
    assert.deepEqual(
      model.keysIn.map(key => `${key.label} ${key.value} ${key.share}`),
      ['cached 180k 64%', 'cache write 42.6k 15%', 'uncached 59.4k 21%'],
    );
    // Output 4 × 500 + 96 + 15 + 0 = 2,111, of which reasoning 4 × 100.
    assert.equal(model.outHead, '2.1k');
    assert.deepEqual(
      model.keysOut.map(key => `${key.label} ${key.value}`),
      ['text 1.7k', 'reasoning 400'],
    );
    assert.equal(model.requests, 8);
    assert.equal(model.pings, 1);
    assert.equal(model.failures, 1);
    assert.equal(model.aria, 'Tokens per request, 8 requests: input 282k, 64% read from cache, 15% written to cache; output 2.1k');
  });

  it('flips the tooltip of the columns in the right part and ends the labels of the last columns at their line', () => {
    assert.deepEqual(
      model.cols.map(col => col.flip),
      [false, false, false, false, false, true, true, true],
    );
    // Eight columns: every label ends at its hairline.
    assert.ok(model.cols.every(col => col.tail));

    const long = buildTokenChart(Array.from({ length: 20 }, (_, i) => req({ at: at(9, i) })), NOW);

    assert.deepEqual(
      long.cols.map(col => col.tail),
      [...Array.from({ length: 12 }, () => false), ...Array.from({ length: 8 }, () => true)],
    );
  });

  it('survives a window of only failed requests and an empty window', () => {
    const failed = buildTokenChart([req({ at: at(10, 0), kind: 'failed', input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, verdict: null })], NOW);

    assert.equal(failed.inHead, '0 · 0% read from cache');
    assert.deepEqual(failed.yIn.map(tick => tick.label), ['0', '1']);

    const empty = buildTokenChart([], NOW);

    assert.deepEqual(empty.cols, []);
    assert.equal(empty.requests, 0);
  });

  it('tables the same requests newest first with dashes for a failed one', () => {
    const rows = tokenTableRows(reqs, NOW);

    assert.equal(rows.length, 8);
    assert.deepEqual(
      rows.slice(0, 3).map(row => `${row.time} ${row.kind} ${row.input} ${row.duration}`),
      ['10:37:58 turn · 1/1 40,000 6.1 s', '10:37:20 failed — 30.0 s', '10:13:02 turn · 1/1 40,000 6.1 s'],
    );
    assert.equal(rows[7].kind, 'turn · 1/1');
    assert.equal(rows[5].kind, 'turn · 2/3');
    assert.equal(rows[3].kind, 'keepalive');
    assert.equal(rows[0].fresh, '9,000');
  });
});
