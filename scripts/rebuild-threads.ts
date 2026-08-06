// Rebuilds the threads projection from the event log: truncate + replay
// (§5.3). The projection is secondary by design; run this offline, with the
// process stopped.
//
// Usage: npm run rebuild-threads

import { prisma } from '../src/db/client.ts';
import { rebuildThreadsProjection } from '../src/core/threads.ts';

const stats = await rebuildThreadsProjection();

console.log(`[rebuild-threads] rebuilt ${stats.threads} threads, applied ${stats.terminals} terminals`);

await prisma.$disconnect();
