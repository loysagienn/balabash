// The pure rules of the telemetry (src/runtime/telemetry.ts): a core's
// load between two samples, the memory lines of /proc/meminfo, the
// interfaces of /proc/net/dev, the rate between two samples.
//
// Run: npm test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cpuLoad, cpuTimesOf, netRate, parseMeminfo, parseNetDev } from './telemetry.ts';

describe('cpu load', () => {
  const times = (user: number, idle: number) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });

  test('is the busy share of each core between two samples', () => {
    const before = cpuTimesOf([times(100, 900), times(0, 1000)]);
    const after = cpuTimesOf([times(150, 950), times(50, 1050)]);

    assert.deepEqual(cpuLoad(before, after), [50, 50]);
  });

  test('is unknown when the cores changed or no time passed, and a core that stood still reads 0 beside one that moved', () => {
    const before = cpuTimesOf([times(100, 900), times(0, 1000)]);

    assert.equal(cpuLoad(before, cpuTimesOf([times(100, 900)])), null);
    assert.equal(cpuLoad([], []), null);
    assert.equal(cpuLoad(before, before), null);
    assert.deepEqual(cpuLoad(before, cpuTimesOf([times(100, 900), times(100, 1000)])), [0, 100]);
  });
});

describe('/proc/meminfo', () => {
  test('reads the total, what is available and the swap, in bytes', () => {
    const text = ['MemTotal:        4009872 kB', 'MemFree:         1117028 kB', 'MemAvailable:    2893072 kB', 'SwapTotal:       2097148 kB', 'SwapFree:        1342480 kB', 'HugePages_Total:       0'].join('\n');

    assert.deepEqual(parseMeminfo(text), {
      totalBytes: 4009872 * 1024,
      usedBytes: (4009872 - 2893072) * 1024,
      swapTotalBytes: 2097148 * 1024,
      swapUsedBytes: (2097148 - 1342480) * 1024,
    });
  });

  test('is null without the total or the available line; no swap lines mean no swap', () => {
    assert.equal(parseMeminfo('MemTotal: 10 kB\n'), null);
    assert.deepEqual(parseMeminfo('MemTotal: 10 kB\nMemAvailable: 4 kB\n'), { totalBytes: 10240, usedBytes: 6144, swapTotalBytes: 0, swapUsedBytes: 0 });
  });
});

describe('/proc/net/dev', () => {
  const text = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 9079019440 5824605    0    0    0     0          0         0 9079019440 5824605    0    0    0     0       0          0',
    '  eth0: 133236544405 97097777    0    0    0     0          0         0 64037360837 101525088    0    0    0     0       0          0',
    '  eth1: 1000 10    0    0    0     0          0         0 2000 20    0    0    0     0       0          0',
  ].join('\n');

  test('sums every interface but the loopback', () => {
    assert.deepEqual(parseNetDev(text), { rx: 133236544405 + 1000, tx: 64037360837 + 2000 });
  });

  test('is null when no interface is named', () => {
    assert.equal(parseNetDev('Inter-| Receive\n face |bytes\n'), null);
    assert.equal(parseNetDev(text.split('\n').slice(0, 3).join('\n')), null);
  });
});

describe('the rate between two samples', () => {
  const sample = (at: number, rx: number, tx: number) => ({ at, cpu: [], net: { rx, tx } });

  test('is bytes per second over the time between them', () => {
    assert.deepEqual(netRate(sample(0, 1000, 500), sample(2000, 5000, 1500)), { inBytesPerSecond: 2000, outBytesPerSecond: 500 });
  });

  test('is unknown without counters or inside the minimal span, and a counter that went down is no traffic', () => {
    assert.equal(netRate({ at: 0, cpu: [], net: null }, sample(2000, 1, 1)), null);
    assert.equal(netRate(sample(0, 1, 1), sample(500, 2, 2)), null);
    assert.deepEqual(netRate(sample(0, 5000, 5000), sample(1000, 100, 100)), { inBytesPerSecond: 0, outBytesPerSecond: 0 });
  });
});
