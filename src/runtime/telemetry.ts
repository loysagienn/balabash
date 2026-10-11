// Machine and process telemetry for the console's System screen
// (GET /api/system, src/api/system.ts): the readings of the host the app
// runs on, taken from the kernel's own counters — os.cpus() and
// /proc/net/dev are cumulative, so a load or a rate is the difference of
// two samples. The module keeps the samples: the newest one for the rates
// a read answers, and one per minute for the last hour of inbound traffic.
// Everything here is a measurement, never an event of the log; what the
// kernel does not offer (no /proc, no statfs) is null, not an error.
//
// The version of the running code — the commit and the branch of the
// checkout the process was started in — is read once at start with git;
// a checkout without git (or a start outside one) has no version.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import type { MachineView, ProcessVersionView } from '../api/contract.ts';

const execFileAsync = promisify(execFile);

// One sample per this interval into the hour's history.
export const SAMPLE_INTERVAL_MS = 60_000;
// The history holds an hour of samples.
export const HISTORY_LENGTH = 60;
// A rate is computed over at least this much time: two samples closer
// than this say nothing about the load.
export const MIN_RATE_SPAN_MS = 1_000;
const GIT_TIMEOUT_MS = 5_000;

export type CpuTimes = { idle: number; total: number };
export type NetBytes = { rx: number; tx: number };
export type Sample = { at: number; cpu: CpuTimes[]; net: NetBytes | null };

// ---------------------------------------------------------------------------
// Pure rules over the kernel's counters.

export function cpuTimesOf(cpus: Pick<os.CpuInfo, 'times'>[]): CpuTimes[] {
  return cpus.map(({ times }) => ({ idle: times.idle, total: times.user + times.nice + times.sys + times.idle + times.irq }));
}

// The busy share of each core between two samples, in percent; null when
// the cores changed or no time passed on any of them.
export function cpuLoad(previous: CpuTimes[], next: CpuTimes[]): number[] | null {
  if (previous.length === 0 || previous.length !== next.length) {
    return null;
  }

  const load = next.map((core, i) => {
    const total = core.total - previous[i].total;
    const idle = core.idle - previous[i].idle;

    return total > 0 ? Math.max(0, Math.min(100, ((total - idle) / total) * 100)) : null;
  });

  return load.every(value => value === null) ? null : load.map(value => value ?? 0);
}

// /proc/meminfo: the lines the view needs, in bytes (the file counts in kB).
export function parseMeminfo(text: string): MachineView['memory'] {
  const values = new Map<string, number>();

  for (const line of text.split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)(?:\s+kB)?/);

    if (match) {
      values.set(match[1], Number(match[2]) * (line.includes('kB') ? 1024 : 1));
    }
  }

  const total = values.get('MemTotal');
  const available = values.get('MemAvailable');

  if (total === undefined || available === undefined) {
    return null;
  }

  const swapTotal = values.get('SwapTotal') ?? 0;
  const swapFree = values.get('SwapFree') ?? swapTotal;

  return { totalBytes: total, usedBytes: Math.max(0, total - available), swapTotalBytes: swapTotal, swapUsedBytes: Math.max(0, swapTotal - swapFree) };
}

// /proc/net/dev: the bytes received and sent over every interface but the
// loopback, summed; null when the file names no interface.
export function parseNetDev(text: string): NetBytes | null {
  let found = false;
  const sum = { rx: 0, tx: 0 };

  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([^\s:]+):\s*(.*)$/);

    if (!match || match[1] === 'lo') {
      continue;
    }

    const fields = match[2].trim().split(/\s+/).map(Number);

    if (fields.length < 9 || fields.some(Number.isNaN)) {
      continue;
    }

    found = true;
    sum.rx += fields[0];
    sum.tx += fields[8];
  }

  return found ? sum : null;
}

// Bytes per second between two samples; null without network counters or
// time between them. A counter that went down (an interface reset) reads as
// no traffic rather than a negative rate.
export function netRate(previous: Sample, next: Sample): { inBytesPerSecond: number; outBytesPerSecond: number } | null {
  const span = next.at - previous.at;

  if (!previous.net || !next.net || span < MIN_RATE_SPAN_MS) {
    return null;
  }

  return {
    inBytesPerSecond: Math.max(0, next.net.rx - previous.net.rx) / (span / 1000),
    outBytesPerSecond: Math.max(0, next.net.tx - previous.net.tx) / (span / 1000),
  };
}

// ---------------------------------------------------------------------------
// The samples.

async function readText(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function takeSample(now = Date.now()): Promise<Sample> {
  const netDev = await readText('/proc/net/dev');

  return { at: now, cpu: cpuTimesOf(os.cpus()), net: netDev ? parseNetDev(netDev) : null };
}

type Rates = { perCore: number[] | null; network: { inBytesPerSecond: number; outBytesPerSecond: number } | null };

// The newest sample any read or tick took, and the rates computed against
// the one before it — a read closer than MIN_RATE_SPAN_MS answers these.
let latest: Sample | null = null;
let latestRates: Rates = { perCore: null, network: null };
// The timer's own samples, one per interval: the inbound bytes between two
// of them are one bar of the hour.
let lastTick: Sample | null = null;
const inboundHistory: number[] = [];

function ratesBetween(previous: Sample, next: Sample): Rates {
  return { perCore: cpuLoad(previous.cpu, next.cpu), network: netRate(previous, next) };
}

async function sampleNow(): Promise<Sample> {
  const sample = await takeSample();

  if (latest && sample.at - latest.at >= MIN_RATE_SPAN_MS) {
    latestRates = ratesBetween(latest, sample);
    latest = sample;
  } else if (!latest) {
    latest = sample;
  }

  return sample;
}

async function tick(): Promise<void> {
  const sample = await sampleNow();

  if (lastTick && sample.net && lastTick.net) {
    inboundHistory.push(Math.max(0, sample.net.rx - lastTick.net.rx));

    if (inboundHistory.length > HISTORY_LENGTH) {
      inboundHistory.splice(0, inboundHistory.length - HISTORY_LENGTH);
    }
  }

  lastTick = sample;
}

// ---------------------------------------------------------------------------
// The version of the running code.

let version: ProcessVersionView = { commit: null, branch: null };

async function git(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: process.cwd(), timeout: GIT_TIMEOUT_MS, encoding: 'utf8' });
    const value = stdout.trim();

    return value || null;
  } catch {
    return null;
  }
}

export async function readVersion(): Promise<ProcessVersionView> {
  const [commit, branch] = await Promise.all([git(['rev-parse', '--short', 'HEAD']), git(['rev-parse', '--abbrev-ref', 'HEAD'])]);

  return { commit, branch: branch === 'HEAD' ? null : branch };
}

export function getVersion(): ProcessVersionView {
  return version;
}

// The moment this process started, from its own clock.
export const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000);

// ---------------------------------------------------------------------------
// The service and the read.

export function startTelemetry(): { name: string; stop: () => void } {
  readVersion()
    .then(read => {
      version = read;
    })
    .catch(() => {});

  tick().catch(error => {
    console.error('[telemetry] sample failed:', error);
  });

  const timer = setInterval(() => {
    tick().catch(error => {
      console.error('[telemetry] sample failed:', error);
    });
  }, SAMPLE_INTERVAL_MS);

  timer.unref();

  return {
    name: 'telemetry',
    stop: () => clearInterval(timer),
  };
}

async function readDisk(): Promise<MachineView['disk']> {
  try {
    // The volume the process runs on: data/ (the workspaces, the local
    // file storage) lives under the working directory.
    const stats = await fs.statfs(process.cwd());
    const bsize = Number(stats.bsize);

    return { totalBytes: Number(stats.blocks) * bsize, usedBytes: (Number(stats.blocks) - Number(stats.bfree)) * bsize, freeBytes: Number(stats.bavail) * bsize };
  } catch {
    return null;
  }
}

// The machine as it is now: a sample against the one before (the rates),
// the kernel's memory and disk, the hour of inbound traffic.
export async function readMachine(): Promise<MachineView> {
  await sampleNow();

  const [meminfo, disk] = await Promise.all([readText('/proc/meminfo'), readDisk()]);
  const [one, five, fifteen] = os.loadavg();

  return {
    uptimeSeconds: os.uptime(),
    cpu: { cores: os.cpus().length, perCore: latestRates.perCore, loadAvg: [one, five, fifteen] },
    memory: meminfo ? parseMeminfo(meminfo) : null,
    disk,
    network: latest?.net ? { ...(latestRates.network ?? { inBytesPerSecond: null, outBytesPerSecond: null }), inboundPerMinute: [...inboundHistory] } : null,
  };
}

// Test seam: forget the samples taken so far.
export function resetTelemetryForTests(): void {
  latest = null;
  latestRates = { perCore: null, network: null };
  lastTick = null;
  inboundHistory.length = 0;
}
