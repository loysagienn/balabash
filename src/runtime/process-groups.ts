// A program or workspace command runs in a detached Linux process group.
// Register it before releasing its starter (IPC for a program, a pipe for
// a command). An empty file created in one syscall is the complete record,
// including the kernel boot and the group leader's start time in clock ticks.
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

const registry = () => path.resolve('data', 'process-groups');
let kernelBoot: string | undefined;

function bootId(): string {
  return kernelBoot ??= readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

function leaderStart(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    // The leader can disappear between open (/proc entry missing) and read.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return null;
    throw error;
  }
  // Field 2 (comm) may contain spaces and parentheses. Field 22 is starttime.
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

function killRecordedGroup(pid: number, start: string): boolean {
  const current = leaderStart(pid);
  if (current !== null && current !== start) return false;

  try {
    return process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}

// Called while the leader is waiting for the app to send it work. Keep the
// record until the group's remaining members have been signalled as well.
export function recordProcessGroup(pid: number): () => void {
  let start: string | null;
  let marker: string;
  try {
    start = leaderStart(pid);
    if (!start) throw new Error(`Process group ${pid} disappeared before registration`);
    const dir = registry();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    marker = path.join(dir, `${bootId()}.${pid}.${start}`);
    closeSync(openSync(marker, 'wx', 0o600));
  } catch (error) {
    console.error(`[process-groups] could not register group ${pid}:`, error);
    throw new Error('Could not register the process group.', { cause: error });
  }

  return () => {
    try {
      killRecordedGroup(pid, start);
      unlinkSync(marker);
    } catch (error) {
      // Boot can retry. The caller already has an outcome for this work.
      console.error(`[process-groups] could not clean up ${marker}:`, error);
    }
  };
}

// Startup only, before the app accepts work or settles interrupted runs.
// A surviving group can have members even when its leader has been reaped.
export function sweepProcessGroups(): void {
  const dir = registry();
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[process-groups] could not read ${dir}:`, error);
    }
    return;
  }

  let records = 0;
  let signalled = 0;
  for (const entry of entries) {
    const match = /^([\da-f-]{36})\.([1-9]\d*)\.(\d+)$/.exec(entry.name);
    const pid = Number(match?.[2]);
    if (!entry.isFile() || !match || pid <= 1 || pid > 0x7fffffff) {
      console.warn(`[process-groups] ignoring unexpected registry entry ${entry.name}`);
      continue;
    }

    records++;
    try {
      const [, boot, , start] = match;
      if (boot === bootId() && killRecordedGroup(pid, start)) signalled++;
      unlinkSync(path.join(dir, entry.name));
    } catch (error) {
      console.error(`[process-groups] could not clean up ${entry.name}:`, error);
    }
  }
  console.log(`[process-groups] found ${records} records, signalled ${signalled} groups`);
}
