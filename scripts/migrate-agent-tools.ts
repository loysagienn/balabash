// Offline step 3, after deploying the additive schema. Nothing in app boot
// runs this script. One transaction publishes the journal and registry together.
import { parseArgs } from 'node:util';
import { prisma } from '../src/db/client.ts';
import { workspaceRoot } from '../src/workspace/layout.ts';
import { migrateCalls } from './agent-tools/history.ts';
import { migrateTasks, moveJobRuns } from './agent-tools/schedule.ts';

const { values } = parseArgs({
  options: {
    database: { type: 'string' },
    workspaces: { type: 'string' },
    programs: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
});

const dryRun = new Error('Roll back the dry run');
let counts;
try {
  await prisma.$transaction(
    async tx => {
      const [actual] = await tx.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
      if (!values.database || values.database !== actual.name)
        throw new Error('Pass the target database name with --database NAME.');
      const peers = await tx.$queryRaw<{ pid: number; application_name: string; state: string | null }[]>`
        SELECT pid, application_name, state FROM pg_stat_activity
        WHERE datname = current_database() AND usename = session_user AND pid <> pg_backend_pid()
          AND backend_type = 'client backend'
        ORDER BY pid`;
      if (peers.length)
        throw new Error('Close other database connections before migrating: ' + JSON.stringify(peers));
      await tx.$executeRaw`LOCK TABLE events, job_runs, schedule_runs, scheduled_tasks IN SHARE ROW EXCLUSIVE MODE NOWAIT`;
      const tasks = await migrateTasks(tx, values.workspaces ?? workspaceRoot(), values.programs);
      const jobs = await moveJobRuns(tx);
      counts = { ...tasks, jobs, ...(await migrateCalls(tx)) };
      if (values['dry-run']) throw dryRun;
    },
    { timeout: 60 * 60 * 1000 },
  );
} catch (error) {
  if (error !== dryRun) throw error;
} finally {
  await prisma.$disconnect();
}
console.log(JSON.stringify(counts));
