// GET /api/system — the console's System screen and the shell's footer:
// the machine (src/runtime/telemetry.ts), this process, the database and
// the file storage as the tables say, the newest walk of the workspace's
// file area (src/workspace/totals.ts), the restart in the way
// (src/runtime/restart.ts). A measurement of the moment, read by place:
// nothing here is an event of the log, so nothing of it is in the
// snapshot — except the system's own events, which the snapshot carries
// as systemLog and the tail keeps (readSystemLog in snapshot.ts).

import { prisma } from '../db/client.ts';
import { getPendingRestart } from '../runtime/restart.ts';
import { countRuns } from '../runtime/runs.ts';
import { PROCESS_STARTED_AT, getVersion, readMachine } from '../runtime/telemetry.ts';
import { countRunningJobs } from '../schedule/engine.ts';
import { getFileAreaTotals } from '../workspace/totals.ts';
import type { DatabaseView, ProcessView, SystemResponse } from './contract.ts';

// The database as the size read finds it: the read answering is the
// database being there; its failure is the view "unavailable" with the
// driver's words — the screen must still show the machine.
async function readDatabase(): Promise<DatabaseView> {
  try {
    const [row] = await prisma.$queryRaw<[{ size: bigint }]>`SELECT pg_database_size(current_database()) AS size`;

    return { available: true, sizeBytes: Number(row.size), error: null };
  } catch (error) {
    return { available: false, sizeBytes: null, error: error instanceof Error ? error.message : String(error) };
  }
}

// The bytes of every stored file — the installation's file storage, one
// for the host whatever the workspace.
async function readFileStorageBytes(): Promise<number | null> {
  try {
    const { _sum } = await prisma.file.aggregate({ _sum: { sizeBytes: true } });

    return _sum.sizeBytes ?? 0;
  } catch {
    return null;
  }
}

function readProcess(): ProcessView {
  const memory = process.memoryUsage();

  return {
    ...getVersion(),
    pid: process.pid,
    node: process.version,
    startedAt: PROCESS_STARTED_AT,
    uptimeSeconds: process.uptime(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    liveSessions: countRuns(),
    workspaceJobs: countRunningJobs(),
  };
}

export async function buildSystem(userId: string): Promise<SystemResponse> {
  const [machine, database, fileStorageBytes] = await Promise.all([readMachine(), readDatabase(), readFileStorageBytes()]);

  return {
    at: new Date(),
    machine,
    process: readProcess(),
    database,
    fileStorageBytes,
    fileArea: getFileAreaTotals(userId),
    restart: { pending: getPendingRestart() },
  };
}
