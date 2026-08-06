import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../prisma-generated/client.ts';
import type { Prisma } from '../../prisma-generated/client.ts';
import { config } from '../config/index.ts';

const adapter = new PrismaPg({ connectionString: config.postgresqlUrl });

export const prisma = new PrismaClient({ adapter });

// Either the root client or an interactive-transaction client: query code in
// core accepts this so the same helpers work inside and outside transactions.
export type DbClient = PrismaClient | Prisma.TransactionClient;
