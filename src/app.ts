// Process entry. Start order (design doc §3): db → files → tombstone of
// orphaned threads → agent catalog → tool servers → web → telegram → router →
// consumers. Stage 3 wires: db, tombstone, agent catalog, telegram, router
// with the coordinator factory and the dynamic-agent spawner, delivery
// consumer.

import { prisma } from './db/client.ts';
import { COORDINATOR_AGENT, tombstoneActiveThreads } from './core/threads.ts';
import { loadAgents } from './capabilities/agent-catalog.ts';
import { spawnAgentRun } from './capabilities/agent-runtime.ts';
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

await loadAgents();

const bot = await initTelegramBot();

startThreadRouter({
  // Lazy rise is for main threads only: dynamic runs are created explicitly
  // on thread.started, and an active child without a run in memory is
  // resume territory — deliberately deferred (§5.5).
  createRun: thread => {
    if (thread.parentId !== null || thread.agent !== COORDINATOR_AGENT) {
      return null;
    }

    const run = createCoordinatorRun({ threadId: thread.id, userId: thread.userId });

    return {
      accept: run.accept,
      // The main thread is eternal; a coordinator run has nothing to abort.
      abort: () => {},
    };
  },

  spawnRun: (thread, startedEvent) => spawnAgentRun(thread, startedEvent),
});

startTelegramDelivery({ bot });

console.log('[app] balabash-v2 is running');
