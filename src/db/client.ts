import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../prisma-generated/client.ts';
import type { Prisma } from '../../prisma-generated/client.ts';
import { config } from '../config/index.ts';
import { testSafeDatabaseUrl } from './test-guard.ts';

// Under node:test only a local test database may be reached (test-guard.ts);
// everywhere else the configured one, required as before — `||`, so an empty
// variable is "not set" to the config getter the way it always was, instead
// of an empty string the driver would fill in from PG* and its defaults.
const connectionString = testSafeDatabaseUrl(process.env.DATABASE_URL, process.env.NODE_TEST_CONTEXT) || config.databaseUrl;

const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });

// Either the root client or an interactive-transaction client: query code in
// core accepts this so the same helpers work inside and outside transactions.
export type DbClient = PrismaClient | Prisma.TransactionClient;
