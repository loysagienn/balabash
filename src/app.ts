// Process entry. Start order (design doc §3): db → files → tombstone of
// orphaned threads → agent catalog → tool servers → web → telegram → router →
// consumers.
//
// Stage 1: only the database layer exists — verify the connection and exit.

import { prisma } from './db/client.ts';

await prisma.$queryRaw`SELECT 1`;

console.log('[app] balabash-v2: database reachable, core ready');
console.log('[app] stage 1 — nothing to run yet, exiting');

await prisma.$disconnect();
