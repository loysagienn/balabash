// The words of the System screen's facts (design: SystemScreen — the
// "Machine", "Balabash process", "Restarts" and "System event log" cards)
// over GET /api/system (the measurements) and the store's system log (the
// events): the meters of the machine, the lines of the process, the note
// of a restart in the way, the rows of the log — restarts requested and
// completed, exceptions, migration failures — and which of them the
// Restarts card shows. Pure, tested.

import type { MachineView, PendingRestartView, ProcessVersionView, ProcessView, SystemResponse } from '../../../api/contract.ts';
import type { Event } from '../../../core/contract.ts';
import { byteLabel, byteShareLabel, countOf, dateTimeLabel, durationLabel, plural, sinceLabel, timeOfDay } from '../../lib/format/index.ts';
import type { IconName } from '../../ui/Icon/icons.ts';
import type { StateName } from '../../ui/atoms/state.ts';
import { lastCompletedSeq, pendingRestartOf } from '../../store/system/selectors.ts';
import { buildLabel } from '../../features/system/version.ts';

// ---------------------------------------------------------------------------
// The machine.

export function percentOf(part: number, whole: number): number {
  return whole > 0 ? Math.round(Math.max(0, Math.min(100, (part / whole) * 100)) * 100) / 100 : 0;
}

// "12d 4h", "16h 17m", "42m", "<1m".
export function uptimeLabel(seconds: number): string {
  return durationLabel(seconds * 1000);
}

// The mean of the cores, in percent; null until the load is known.
export function cpuAverage(perCore: number[] | null): number | null {
  return perCore && perCore.length ? perCore.reduce((sum, value) => sum + value, 0) / perCore.length : null;
}

// The per-core bars, one per core: up to 32 they fit the meter at the
// narrowest (2px a bar, 2px between); past that they would spill out of it
// and tell nothing core by core — the meter keeps the gauge and the load.
export const PER_CORE_BARS_MAX = 32;

export function showsPerCore(perCore: readonly number[]): boolean {
  return perCore.length <= PER_CORE_BARS_MAX;
}

// "CPU · 8 cores" / "load 0.42 · 0.51 · 0.48".
export function cpuWords(cpu: MachineView['cpu']): { title: string; load: string } {
  return { title: `CPU · ${countOf(cpu.cores, 'core')}`, load: `load ${cpu.loadAvg.map(value => value.toFixed(2)).join(' · ')}` };
}

// "9.8 of 16 GB" / "swap 4% · 0.3 of 8 GB" (or "no swap").
export function memoryWords(memory: NonNullable<MachineView['memory']>): { percent: number; main: string; swap: string } {
  const swap = memory.swapTotalBytes > 0 ? `swap ${Math.round(percentOf(memory.swapUsedBytes, memory.swapTotalBytes))}% · ${byteShareLabel(memory.swapUsedBytes, memory.swapTotalBytes)}` : 'no swap';

  return { percent: percentOf(memory.usedBytes, memory.totalBytes), main: byteShareLabel(memory.usedBytes, memory.totalBytes), swap };
}

// "131 of 200 GB · 69 GB free".
export function diskWords(disk: NonNullable<MachineView['disk']>): { percent: number; main: string } {
  return { percent: percentOf(disk.usedBytes, disk.totalBytes), main: `${byteShareLabel(disk.usedBytes, disk.totalBytes)} · ${byteLabel(disk.freeBytes)} free` };
}

// "in 1.2 MB/s · out 0.3 MB/s"; before two samples — what is being done.
export function networkWords(network: NonNullable<MachineView['network']>): string {
  if (network.inBytesPerSecond === null || network.outBytesPerSecond === null) {
    return 'measuring the rate…';
  }

  return `in ${byteLabel(network.inBytesPerSecond)}/s · out ${byteLabel(network.outBytesPerSecond)}/s`;
}

// "inbound traffic · last hour" / "… · last 7 min"; null without a bar.
export function trafficCaption(minutes: number): string | null {
  if (minutes < 2) {
    return null;
  }

  return minutes >= 60 ? 'inbound traffic · last hour' : `inbound traffic · last ${minutes} min`;
}

// The bars of a spark: each value as a share of the largest, in percent.
export function sparkOf(values: readonly number[]): number[] {
  const max = Math.max(0, ...values);

  return max > 0 ? values.map(value => percentOf(value, max)) : values.map(() => 0);
}

// A size: "41 GB", "measuring…" while the file area is not walked yet,
// "—" for what the host did not say.
export function consumerWords(bytes: number | null, pending = false): string {
  if (bytes !== null) {
    return byteLabel(bytes);
  }

  return pending ? 'measuring…' : '—';
}

export type DiskConsumers = {
  // What lies on the volume the meter shows, under the working directory:
  // the file area of this workspace, the local file storage.
  items: { key: string; value: string }[];
  // The sizes that are not of this volume — the database (a remote one
  // takes no room here; a local one is on another path), a Spaces file
  // storage — named apart so the breakdown does not claim them.
  elsewhere: string | null;
};

// The consumers under the disk meter: the file area ("at least 1.2 GB"
// after an incomplete walk) and the local file storage are of this volume;
// the database and a Spaces storage are said apart. An older server names
// the storage's bytes alone — then the storage has no driver to say.
export function diskConsumers(facts: Pick<SystemResponse, 'fileArea' | 'fileStorage' | 'database'>): DiskConsumers {
  const area = facts.fileArea;
  const items = [{ key: 'file area · this workspace', value: area === null ? consumerWords(null, true) : `${area.complete === false ? 'at least ' : ''}${byteLabel(area.bytes)}` }];
  const storage = facts.fileStorage ?? null;
  const elsewhere: string[] = [];

  if (storage?.kind === 'spaces') {
    elsewhere.push(`file storage ${consumerWords(storage.bytes)} (Spaces)`);
  } else {
    items.push({ key: storage ? 'file storage · local' : 'file storage', value: consumerWords(storage?.bytes ?? null) });
  }

  const database = facts.database;
  const where = database.local === true ? 'PostgreSQL on this host' : database.local === false ? 'remote PostgreSQL' : 'PostgreSQL';

  elsewhere.push(`database ${consumerWords(database.sizeBytes)} (${where})`);

  return { items, elsewhere: `outside the breakdown: ${elsewhere.join(' · ')}` };
}

// ---------------------------------------------------------------------------
// The process.

// "16h 17m · since Oct 8, 00:21".
export function processUptimeWords(startedAt: Date, now: Date): string {
  return `${durationLabel(now.getTime() - startedAt.getTime())} · ${sinceLabel(startedAt, now)}`;
}

// "4 live · 1 workspace job" — the runs alive in the process, every
// workspace's (the sidebar counts this workspace's active threads instead).
export function sessionsWords(process: Pick<ProcessView, 'liveSessions' | 'workspaceJobs'>): string {
  return `${process.liveSessions} live · ${countOf(process.workspaceJobs, 'workspace job')}`;
}

export type VersionWords = {
  // "3f9c21e", "3f9c21e+" — the build's commit, "+" when the tree held
  // uncommitted changes at the build; null without a build stamp.
  build: string | null;
  // "main · built Oct 8, 00:21" — what else the stamp says.
  details: string | null;
  // "7b15d2d · main" — the checkout the process started in, when it is
  // another commit than the build's (a rolled-back bundle, a checkout
  // moved without a build), or the only version known without a stamp.
  checkout: string | null;
};

export function versionWords(version: ProcessVersionView, now: Date): VersionWords {
  const build = buildLabel(version);
  const builtAt = version.builtAt ?? null;
  const details = [version.branch, builtAt ? `built ${dateTimeLabel(builtAt, now)}` : null].filter((part): part is string => part !== null);
  const checkout = version.checkout ?? null;

  return {
    build,
    details: build && details.length ? details.join(' · ') : null,
    checkout: checkout && checkout.commit !== version.commit ? `${checkout.commit}${checkout.branch ? ` · ${checkout.branch}` : ''}` : null,
  };
}

// "updated 16:38 · every 10s" — the shell's subtitle; null before the first answer.
export function updatedWords(dataUpdatedAt: number, everyMs: number): string | null {
  return dataUpdatedAt > 0 ? `updated ${timeOfDay(new Date(dataUpdatedAt))} · every ${Math.round(everyMs / 1000)}s` : null;
}

// ---------------------------------------------------------------------------
// The restart in the way.

export type RestartNote = {
  // "Requested by engineer at 16:05" / "Requested from another workspace at 16:05"
  lead: string;
  // The threads of this workspace the window waits for, to be drawn as
  // links after the tail; empty when the wait is for something else, or
  // unknown.
  threads: { id: string; title: string | null; agent: string }[];
  // " · waiting for 2 threads to close:" / " · waiting for a secretary turn to end" / " · restarting now" / " · checking the safe window"
  tail: string;
};

// The request as the note needs it: who asked and when, whether forced,
// whether it is this workspace's own (another workspace's request has no
// requester to name).
export type RestartSource = { requestedBy: string | null; requestedAt: Date; force: boolean; own: boolean };

function waitWords(waiting: NonNullable<PendingRestartView['waiting']>): string {
  const reasons: string[] = [];

  if (waiting.secretaryTurn) {
    reasons.push('a secretary turn to end');
  }
  if (waiting.workspaceJob) {
    reasons.push('a workspace job to end');
  }
  if (!waiting.logQuiet) {
    reasons.push('the log to go quiet');
  }
  if ((waiting.otherThreads ?? 0) > 0) {
    reasons.push(`${countOf(waiting.otherThreads, 'thread')} of other workspaces to close`);
  }
  // Last: the threads of this workspace follow as links.
  if (waiting.threads.length) {
    reasons.push(`${countOf(waiting.threads.length, 'thread')} to close:`);
  }

  if (reasons.length === 0) {
    return ' · restarting now';
  }

  return ` · waiting for ${reasons.join(', ')}`;
}

// The note of the restart in the way: the request, and what the poll found
// in the way when the facts name it (undefined — the facts did not answer
// yet; null — no poll yet).
export function restartNote(request: RestartSource, waiting: PendingRestartView['waiting'] | undefined, now: Date): RestartNote {
  const when = dateTimeLabel(request.requestedAt, now);
  const lead = `${request.own ? `Requested by ${request.requestedBy ?? 'the operator'}` : 'Requested from another workspace'} at ${when}${request.force ? ' · force' : ''}`;

  if (!waiting) {
    return { lead, threads: [], tail: ' · checking the safe window' };
  }

  return { lead, threads: waiting.threads, tail: waitWords(waiting) };
}

// The request event of the store as the note's input.
export function requestOf(event: Event): RestartSource {
  return {
    requestedBy: typeof event.payload.requestedBy === 'string' ? event.payload.requestedBy : null,
    requestedAt: event.createdAt,
    force: event.payload.force === true,
    own: true,
  };
}

// The restart in the way as the card learns it, from two sources checked
// against each other by seq: the facts' pending (GET /api/system — the
// request as the process holds it, this workspace's or another's, with
// what the window waits for) unless the log holds a completion past it
// (the facts are from before that restart); else the log's newest request
// after its newest completion (the facts not answered yet, or older than
// the request — the window is then still unknown). A pending of an older
// server, without a seq, cannot be matched and is left to the log. Null
// when nothing is in the way.
export function pendingOf(log: readonly Event[], pending: PendingRestartView | null | undefined): { request: RestartSource; waiting: PendingRestartView['waiting'] | undefined } | null {
  const completed = lastCompletedSeq(log);

  if (pending && typeof pending.seq === 'number' && (completed === null || BigInt(pending.seq) > completed)) {
    return {
      request: { requestedBy: pending.requestedBy, requestedAt: pending.requestedAt, force: pending.force, own: pending.own !== false },
      waiting: pending.waiting,
    };
  }

  const request = pendingRestartOf(log);

  return request ? { request: requestOf(request), waiting: undefined } : null;
}

// ---------------------------------------------------------------------------
// The rows of the log.

export type LogKind = 'restart' | 'exception';

export type LogRow = {
  key: string;
  seq: bigint;
  at: Date;
  kind: LogKind;
  icon: IconName;
  state: StateName | undefined;
  title: string;
  meta: string;
  status: { state: StateName; label: string } | null;
  // Under the time: how long the restart took.
  sub: string | null;
  threadId: string | null;
};

const TITLE_MAX = 110;
const META_MAX = 200;

export function clip(text: string, max: number): string {
  const line = text.split('\n').find(part => part.trim())?.trim() ?? '';

  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : [];
}

// "38s", "2m" — how long a restart took, from its request to the completion.
export function tookLabel(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : durationLabel(ms);
}

function exceptionRow(event: Event, base: Pick<LogRow, 'key' | 'seq' | 'at' | 'threadId'>): LogRow {
  const payload = event.payload;
  const error = clip(text(payload.error) ?? '', META_MAX);
  const scope = text(payload.scope);

  if (scope === 'migrate-deploy') {
    return { ...base, kind: 'restart', icon: 'database', state: 'err', title: 'Migrations failed to apply', meta: error, status: { state: 'err', label: 'failed' }, sub: null };
  }

  if (scope === 'supervisor-rollback') {
    return { ...base, kind: 'restart', icon: 'rotate-ccw', state: 'err', title: 'Rolled back to the last good bundle', meta: error, status: { state: 'err', label: 'rolled back' }, sub: null };
  }

  const slug = text(payload.slug);

  if (slug) {
    const status = text(payload.status);
    const exitCode = typeof payload.exitCode === 'number' ? ` · exit code ${payload.exitCode}` : '';

    return { ...base, kind: 'exception', icon: 'calendar-x', state: 'err', title: `Task “${slug}” ${status === null || status === 'failed' ? 'failed' : status}`, meta: `${error}${exitCode}`, status: null, sub: null };
  }

  const consumer = text(payload.consumerName);
  const eventType = text(payload.eventType);
  const title = consumer ? `${consumer} failed${eventType ? ` on ${eventType}` : ''}` : scope ? `Exception · ${scope}` : 'System exception';

  return { ...base, kind: 'exception', icon: 'triangle-alert', state: 'err', title: clip(title, TITLE_MAX), meta: error, status: null, sub: null };
}

// Newest first: a completion names its request (requestSeq) for who asked
// and how long it took, when the log still holds it; a request after the
// newest completion is in the way (state wait).
export function logRows(log: readonly Event[]): LogRow[] {
  const completed = lastCompletedSeq(log);
  const requests = new Map<number, Event>();

  for (const event of log) {
    if (event.type === 'system.restart.requested') {
      requests.set(Number(event.seq), event);
    }
  }

  const rows: LogRow[] = [];

  for (const event of log) {
    const base = { key: String(event.seq), seq: event.seq, at: event.createdAt, threadId: event.threadId ?? event.targetThreadId ?? null };

    if (event.type === 'system.restart.requested') {
      const pending = completed === null || event.seq > completed;
      const who = text(event.payload.requestedBy) ?? 'the operator';

      rows.push({
        ...base,
        kind: 'restart',
        icon: 'hourglass',
        state: pending ? 'wait' : undefined,
        title: 'Restart requested',
        meta: `${who} · ${clip(text(event.payload.reason) ?? 'restart', META_MAX)}`,
        status: pending ? { state: 'wait', label: 'pending' } : null,
        sub: null,
      });
      continue;
    }

    if (event.type === 'system.restart.completed') {
      const request = typeof event.payload.requestSeq === 'number' ? requests.get(event.payload.requestSeq) : undefined;
      const rolledBack = event.payload.rolledBack === true;
      const failed = list(event.payload.migrationsFailed);
      const who = request ? (text(request.payload.requestedBy) ?? 'the operator') : null;
      const parts = [who ? `requested by ${who}` : null, rolledBack ? `rolled back to the last good bundle${text(event.payload.rollbackReason) ? ` (${event.payload.rollbackReason})` : ''}` : null, failed.length ? `migrations failed: ${clip(failed.join(', '), 120)}` : null].filter((part): part is string => part !== null);

      rows.push({
        ...base,
        kind: 'restart',
        icon: 'rotate-cw',
        state: rolledBack || failed.length ? 'err' : undefined,
        title: `Restart · ${clip(text(event.payload.reason) ?? 'restart', TITLE_MAX)}`,
        meta: parts.join(' · '),
        status: rolledBack ? { state: 'err', label: 'rolled back' } : failed.length ? { state: 'err', label: 'migrations failed' } : { state: 'done', label: 'done' },
        sub: request ? tookLabel(event.createdAt.getTime() - request.createdAt.getTime()) : null,
      });
      continue;
    }

    if (event.type === 'system.exception') {
      rows.push(exceptionRow(event, base));
    }
  }

  return rows.reverse();
}

// The Restarts card: completions, requests and what broke a boot.
export function restartRows(rows: readonly LogRow[]): LogRow[] {
  return rows.filter(row => row.kind === 'restart');
}

export type LogFilter = 'all' | 'restart' | 'exception';

export const LOG_FILTERS: { key: LogFilter; label: string; icon: IconName }[] = [
  { key: 'all', label: 'all', icon: 'activity' },
  { key: 'restart', label: 'restarts', icon: 'rotate-cw' },
  { key: 'exception', label: 'exceptions', icon: 'triangle-alert' },
];

export function filteredRows(rows: readonly LogRow[], filter: LogFilter): LogRow[] {
  return filter === 'all' ? [...rows] : rows.filter(row => row.kind === filter);
}

// "no events yet" / "no exceptions" — the empty log under a filter.
export function emptyLogWords(filter: LogFilter): string {
  return filter === 'all' ? 'No system events yet' : filter === 'restart' ? 'No restarts yet' : 'No exceptions';
}

// The summary of System on Home: "CPU 14% · disk 66%"; what is unknown is
// left out, nothing known — no summary.
export function systemSummary(facts: Pick<SystemResponse, 'machine'> | null): string | null {
  if (!facts) {
    return null;
  }

  const cpu = cpuAverage(facts.machine.cpu.perCore);
  const parts = [cpu === null ? null : `CPU ${Math.round(cpu)}%`, facts.machine.disk ? `disk ${Math.round(percentOf(facts.machine.disk.usedBytes, facts.machine.disk.totalBytes))}%` : null].filter((part): part is string => part !== null);

  return parts.length ? parts.join(' · ') : null;
}

// "2,418 files · 1.2 GB" — the summary of Files on Home and of a
// project's folder; an incomplete walk (cut at its cap, or with what it
// could not read) is a lower bound: "at least".
export function fileAreaSummary(totals: { files: number; bytes: number; complete?: boolean } | null): string | null {
  if (!totals) {
    return null;
  }

  const bound = totals.complete === false ? 'at least ' : '';

  return `${bound}${countOf(totals.files, 'file')} · ${byteLabel(totals.bytes)}`;
}

export { plural };
