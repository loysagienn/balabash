// The lifecycle of the test PostgreSQL (pg.ts) on a stand-in cluster, no
// server started: the boot chain is cancelled by its timeout, a server that
// exits before it is ready is named, and stopping a cluster whose stop()
// never comes back is bounded.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { bootCluster, stopCluster } from './pg.ts';
import type { Cluster } from './pg.ts';

type Fake = Cluster & { calls: string[] };

function fake(overrides: Partial<Cluster> = {}): Fake {
  const calls: string[] = [];
  const step = (name: string) => async () => {
    calls.push(name);
  };
  return {
    calls,
    initialise: step('initialise'),
    start: step('start'),
    createDatabase: async (name: string) => {
      calls.push(`createDatabase ${name}`);
    },
    stop: step('stop'),
    ...overrides,
  };
}

describe('bootCluster', () => {
  it('runs initdb, the server and the template in order', async () => {
    const cluster = fake();

    await bootCluster(cluster, 1_000);

    assert.deepEqual(cluster.calls, ['initialise', 'start', 'createDatabase balabash_template_test']);
  });

  it('gives up by the timeout and does not start a server after it', async () => {
    const cluster = fake({
      initialise: async () => {
        cluster.calls.push('initialise');
        await sleep(60);
      },
    });

    await assert.rejects(bootCluster(cluster, 10), /did not start in 0.01 s/);
    await sleep(100);

    assert.deepEqual(cluster.calls, ['initialise']);
  });

  it('names a server that exited before it was ready (start() rejects with nothing)', async () => {
    const cluster = fake({
      start: () => Promise.reject(undefined),
    });

    await assert.rejects(bootCluster(cluster, 1_000), /exited before it was ready/);
    assert.deepEqual(cluster.calls, ['initialise']);
  });

  it('passes a failure of a step through', async () => {
    const cluster = fake({
      createDatabase: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });

    await assert.rejects(bootCluster(cluster, 1_000), /ECONNREFUSED/);
  });
});

describe('stopCluster', () => {
  it('comes back when stop() does', async () => {
    const cluster = fake();

    await stopCluster(cluster, 1_000);

    assert.deepEqual(cluster.calls, ['stop']);
  });

  it('is bounded when stop() never comes back, and does not throw', async () => {
    const cluster = fake({ stop: () => new Promise<void>(() => {}) });
    const started = Date.now();

    await stopCluster(cluster, 20);

    assert.ok(Date.now() - started < 1_000);
  });

  it('swallows a failing stop()', async () => {
    const cluster = fake({ stop: () => Promise.reject(new Error('no such process')) });

    await stopCluster(cluster, 1_000);
  });
});
