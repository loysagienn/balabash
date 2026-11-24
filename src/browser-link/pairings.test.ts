// Pairing codes (pairings.ts): a code stands for who asked for it, once and
// for ten minutes.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPairings } from './pairings.ts';

const pairing = { userId: 'user-1', workspaceId: 'workspace-1', name: 'MacBook' };

test('a code gives back the user, the workspace and the name it was issued for — once', () => {
  const pairings = createPairings();
  const { code } = pairings.issue(pairing);

  assert.deepEqual(pairings.redeem(code), pairing);
  assert.equal(pairings.redeem(code), null, 'a used code is gone');
  assert.equal(pairings.redeem('not-a-code'), null);
});

test('a code dies ten minutes after it was issued', () => {
  let now = 1_000_000;
  const pairings = createPairings(() => now);
  const fresh = pairings.issue(pairing);
  const stale = pairings.issue(pairing);

  assert.equal(fresh.expiresAt.getTime(), now + 10 * 60_000);
  assert.notEqual(fresh.code, stale.code);

  now += 10 * 60_000 - 1;
  assert.deepEqual(pairings.redeem(fresh.code), pairing);

  now += 1;
  assert.equal(pairings.redeem(stale.code), null);
});
