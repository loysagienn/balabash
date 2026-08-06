// Process entry. Start order (design doc §3): db → files → tombstone of
// orphaned threads → agent catalog → tool servers → web → telegram → router →
// consumers. Stage 2 wires the subset that exists: db, tombstone, telegram,
// router with the coordinator factory, delivery consumer.

import { prisma } from './db/client.ts';
import { COORDINATOR_AGENT, tombstoneActiveThreads } from './core/threads.ts';
import { createCoordinatorRun } from './coordinator/index.ts';
import { startThreadRouter } from './runtime/router.ts';
import { initTelegramBot } from './adapters/telegram/bot.ts';
import { startTelegramDelivery } from './adapters/telegram/delivery.ts';

await prisma.$queryRaw`SELECT 1`;
console.log('[app] balabash-v2: database reachable');

// Runs live only in memory: threads orphaned by the previous process death
// are cancelled before anything can address them (§5.5).
const tombstoned = await tombstoneActiveThreads('process_restart');

if (tombstoned > 0) {
  console.log(`[app] tombstoned ${tombstoned} orphaned threads`);
}

const bot = await initTelegramBot();

startThreadRouter({
  // Stage 2: the only runnable agent is the coordinator of a main thread.
  // Dynamic agents join at stage 3 through the same factory.
  createRun: thread => {
    if (thread.parentId !== null || thread.agent !== COORDINATOR_AGENT) {
      return null;
    }

    return createCoordinatorRun({ threadId: thread.id, userId: thread.userId });
  },
});

startTelegramDelivery({ bot });

console.log('[app] balabash-v2 is running');
