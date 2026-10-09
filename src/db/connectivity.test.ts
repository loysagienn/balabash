import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isConnectivityError } from './connectivity.ts';

describe('isConnectivityError', () => {
  it('recognises Prisma connectivity codes', () => {
    for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024']) {
      assert.equal(isConnectivityError(Object.assign(new Error('x'), { code })), true, code);
    }
  });

  it('recognises the shape Prisma 7 produced on 2026-10-09: P1001 with the driver adapter error nested in meta', () => {
    const error = Object.assign(new Error("Invalid `prisma.event.findMany()` invocation:\nCan't reach database server at 152.42.139.94:25060"), {
      code: 'P1001',
      meta: {
        modelName: 'Event',
        driverAdapterError: Object.assign(new Error('DatabaseNotReachable'), {
          name: 'DriverAdapterError',
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        }),
      },
    });

    assert.equal(isConnectivityError(error), true);
  });

  it('recognises a socket error nested only under meta or cause', () => {
    const viaMeta = Object.assign(new Error('query failed'), {
      meta: { driverAdapterError: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) },
    });
    const viaCause = Object.assign(new Error('query failed'), {
      cause: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
    });

    assert.equal(isConnectivityError(viaMeta), true);
    assert.equal(isConnectivityError(viaCause), true);
  });

  it('recognises the wording of code-less server messages', () => {
    assert.equal(isConnectivityError(new Error('Connection terminated unexpectedly')), true);
    assert.equal(isConnectivityError(new Error('terminating connection due to administrator command')), true);
    assert.equal(isConnectivityError(new Error('the database system is starting up')), true);
  });

  it('leaves genuine failures alone', () => {
    assert.equal(isConnectivityError(new Error('bad payload')), false);
    assert.equal(isConnectivityError(Object.assign(new Error('unique constraint'), { code: 'P2002' })), false);
    assert.equal(isConnectivityError(new TypeError("Cannot read properties of undefined (reading 'id')")), false);
    assert.equal(isConnectivityError(null), false);
    assert.equal(isConnectivityError('string'), false);
  });

  it('tolerates cycles in the error chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };

    a.cause = b;
    b.cause = a;

    assert.equal(isConnectivityError(a), false);
  });
});
