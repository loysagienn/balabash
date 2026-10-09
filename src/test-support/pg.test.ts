// The test PostgreSQL itself (pg.ts): a copy of the template is a migrated
// database of its own, copies are independent and may be taken at once, a
// Prisma client built the way db/client.ts builds it reaches one, and the
// guard lets its URL through.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../prisma-generated/client.ts';
import { BLOCKED_DATABASE_URL, testSafeDatabaseUrl } from '../db/test-guard.ts';
import { createTestDatabase } from './pg.ts';
import type { TestDatabase } from './pg.ts';

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
});

after(async () => {
  await db.drop();
});

async function rows(url: string, sql: string): Promise<Record<string, unknown>[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql)).rows;
  } finally {
    await client.end();
  }
}

describe('test PostgreSQL', () => {
  test('a copy of the template holds every migration applied', async () => {
    const entries = await fs.readdir(path.resolve('prisma', 'migrations'), { withFileTypes: true });
    const migrations = entries.filter(entry => entry.isDirectory()).length;
    const [row] = await rows(db.url, 'select current_database() as name, (select count(*)::int from _prisma_migrations where finished_at is not null and rolled_back_at is null) as applied');

    assert.equal(row.name, db.name);
    assert.match(db.name, /_test$/);
    assert.equal(row.applied, migrations);
    assert.deepEqual(await rows(db.url, 'select count(*)::int as n from users'), [{ n: 0 }]);
  });

  test('the child is cut off from the inherited DATABASE_URL and the guard lets the copy through', () => {
    assert.equal(process.env.DATABASE_URL, BLOCKED_DATABASE_URL);
    assert.ok(process.env.NODE_TEST_CONTEXT);
    assert.equal(testSafeDatabaseUrl(db.url, process.env.NODE_TEST_CONTEXT), db.url);
  });

  test('a Prisma client over the adapter reaches the copy', async () => {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: db.url }) });

    try {
      assert.equal(await prisma.user.count(), 0);
      assert.equal(await prisma.event.count(), 0);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('copies taken at once are independent of each other and of the first', async () => {
    const [a, b] = await Promise.all([createTestDatabase(), createTestDatabase()]);

    try {
      await rows(a.url, "insert into users (id, created_at, updated_at) values ('u-a', now(), now())");

      assert.deepEqual(await rows(a.url, 'select id from users'), [{ id: 'u-a' }]);
      assert.deepEqual(await rows(b.url, 'select id from users'), []);
      assert.deepEqual(await rows(db.url, 'select id from users'), []);
    } finally {
      await Promise.all([a.drop(), b.drop()]);
    }
  });
});
