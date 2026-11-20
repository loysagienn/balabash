// Offline step 3, after deploying the additive schema. Nothing in app boot
// runs this script. One transaction publishes the journal and registry together.
import { parseArgs } from 'node:util';
import { prisma } from '../src/db/client.ts';
import { workspaceRoot } from '../src/workspace/layout.ts';
import { migrateCalls } from './agent-tools/history.ts';
import { migrateTasks, moveJobRuns } from './agent-tools/schedule.ts';

const { values } = parseArgs({ options: {
  database: { type: 'string' }, workspaces: { type: 'string' }, programs: { type: 'string' },
} });
try {
  const result = await prisma.$transaction(async tx => {
    const [actual] = await tx.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (!values.database || values.database !== actual.name) throw new Error('Pass the target database name with --database NAME.');
    // Require an offline writer. Readers may keep reading the old snapshot.
    await tx.$executeRaw`LOCK TABLE events, job_runs, schedule_runs, scheduled_tasks IN SHARE ROW EXCLUSIVE MODE NOWAIT`;
    const tasks = await migrateTasks(tx, values.workspaces ?? workspaceRoot(), values.programs);
    const jobs = await moveJobRuns(tx);
    return { ...tasks, jobs, ...await migrateCalls(tx) };
  }, { timeout: 60 * 60 * 1000 });
  console.log(JSON.stringify(result));
} finally {
  await prisma.$disconnect();
}
