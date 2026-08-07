// Process entry. Start order (design doc §3): db → files → tombstone of
// orphaned threads → agent catalog → tool servers → web → telegram → router →
// consumers → restart module. The process runs under supervisor.js: a clean
// exit with RESTART_EXIT_CODE relaunches it, exit 0 stops the pair.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Consumer } from './core/consumers.ts';
import { prisma } from './db/client.ts';
import { COORDINATOR_AGENT, tombstoneActiveThreads } from './core/threads.ts';
import { getFile, getFileDownloadUrl, ingestFile } from './files/index.ts';
import { loadAgents } from './capabilities/agent-catalog.ts';
import { spawnAgentRun } from './capabilities/agent-runtime.ts';
import { createAuthToolServer } from './capabilities/auth-tools.ts';
import { createRestartToolServer } from './capabilities/restart-tools.ts';
import { startReauthDetector } from './capabilities/reauth-detector.ts';
import { loadToolServers, registerBuiltinToolServer } from './capabilities/tool-manager.ts';
import { createCoordinatorRun, hasActiveCoordinatorTurns } from './coordinator/index.ts';
import { startWebServer } from './web/index.ts';
import { startThreadRouter } from './runtime/router.ts';
import { RESTART_EXIT_CODE, completePendingRestarts, startRestartModule } from './runtime/restart.ts';
import { initTelegramBot } from './adapters/telegram/bot.ts';
import { startTelegramDelivery } from './adapters/telegram/delivery.ts';

// Pending migrations are applied before anything else touches the database:
// schema changes ride the same restart as the code that needs them. A
// failure is survivable BY DESIGN — booting continues on the old schema with
// a loud journal instead of exiting: a broken migration file lives in the
// repo, not in dist/, so a crash-exit would loop forever and no bundle
// rollback could cure it. The additive-only migration discipline lives in
// the claude agent's rules; the error reaches the user through
// completePendingRestarts and system.exception.
let migrationsError: string | null = null;

try {
  const { stdout } = await promisify(execFile)(
    path.resolve('node_modules', '.bin', 'prisma'),
    ['migrate', 'deploy'],
    { timeout: 120_000 },
  );

  console.log(`[app] migrations: ${stdout.trim().split('\n').at(-1) ?? 'done'}`);
} catch (error) {
  const execError = error as { stderr?: string; message?: string };

  migrationsError = (execError.stderr?.trim() || execError.message || String(error)).slice(0, 2000);
  console.error('[app] prisma migrate deploy failed (booting anyway):', migrationsError);
}

await prisma.$queryRaw`SELECT 1`;
console.log('[app] balabash-v2: database reachable');

// Runs live only in memory: threads orphaned by the previous process death
// are cancelled before anything can address them (§5.5). A planned restart
// leaves nothing to tombstone — the safe window required every child thread
// to finish first.
const tombstoned = await tombstoneActiveThreads('process_restart');

if (tombstoned > 0) {
  console.log(`[app] tombstoned ${tombstoned} orphaned threads`);
}

loadAgents();

// Consent servers (§7.4): only agents naming them explicitly get them — the
// auth tools for the auth agent, the restart request for the coordinator and
// the claude engineering agent.
registerBuiltinToolServer(createAuthToolServer());
registerBuiltinToolServer(createRestartToolServer());

// Local tool servers see the global files surface; workspace scoping happens
// at the calling run (§7.4).
await loadToolServers({
  filesApi: {
    ingest: input => ingestFile(input),
    get: fileId => getFile(fileId),
    getDownloadUrl: (fileId, options) => getFileDownloadUrl(fileId, options),
  },
});

startWebServer();

const { bot, stop: stopTelegram } = await initTelegramBot();

const consumers: Consumer[] = [];

consumers.push(
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
  }),
);

consumers.push(startTelegramDelivery({ bot }));

consumers.push(startReauthDetector());

// Every boot satisfies the restart requests recorded before it — report the
// completions (with the supervisor's rollback marker and a migration
// failure riding along, if any), then watch for new requests.
await completePendingRestarts({ migrationsError });

consumers.push(
  startRestartModule({
    isBusy: hasActiveCoordinatorTurns,
    onRestartWindow: () => shutdown(RESTART_EXIT_CODE),
  }),
);

console.log('[app] balabash-v2 is running');

// ---------------------------------------------------------------------------
// Shutdown: stop taking input (telegram polling confirms its offset), stop
// the consumer loops, release the db and exit. The supervisor reads the exit
// code: RESTART_EXIT_CODE relaunches, 0 stops the pair.

let shuttingDown = false;

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`[app] shutting down (exit code ${code})`);

  await stopTelegram().catch(error => {
    console.error('[app] telegram stop failed:', error);
  });

  for (const consumer of consumers) {
    try {
      consumer.stop();
    } catch (error) {
      console.error(`[app] failed to stop consumer "${consumer.name}":`, error);
    }
  }

  await prisma.$disconnect().catch(() => {});

  process.exit(code);
}

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));
