// A program or workspace command runs in a detached Linux process group.
// Register it before releasing its starter (IPC for a program, a pipe for
// a command). An empty file created in one syscall is the complete record,
// including the kernel boot and the group leader's start time in clock ticks.
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
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

function killRecordedGroup(pid: number, start: string): void {
  const current = leaderStart(pid);
  if (current !== null && current !== start) return;

  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export class ProcessGroupCleanupError extends Error {}

// Called while the leader is waiting for the app to send it work. Keep the
// record until the group's remaining members have been signalled as well.
export function recordProcessGroup(pid: number): () => void {
  const start = leaderStart(pid);
  if (!start) throw new Error(`Process group ${pid} disappeared before registration`);
  const dir = registry();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = path.join(dir, `${bootId()}.${pid}.${start}`);
  closeSync(openSync(marker, 'wx', 0o600));

  return () => {
    try {
      killRecordedGroup(pid, start);
    } catch (error) {
      throw new ProcessGroupCleanupError(`Could not stop process group ${pid} after execution: ${String(error)}`, { cause: error });
    }
    // The command may already have taken effect. Losing the ability to
    // unlink a marker leaves it for boot; it does not undo the outcome.
    try {
      unlinkSync(marker);
    } catch (error) {
      console.error(`[process-groups] could not remove ${marker}:`, error);
    }
  };
}

// Startup only, before the app accepts work or settles interrupted runs.
// A surviving group can have members even when its leader has been reaped.
export function sweepProcessGroups(): void {
  const dir = registry();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  for (const name of names) {
    const match = /^([\da-f-]{36})\.([1-9]\d*)\.(\d+)$/.exec(name);
    if (!match) throw new Error(`Invalid process group record: ${name}`);
    const [, boot, group, start] = match;
    const pid = Number(group);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 0x7fffffff) {
      throw new Error(`Invalid process group id in ${name}`);
    }
    if (boot === bootId()) killRecordedGroup(pid, start);
    unlinkSync(path.join(dir, name));
  }
}
