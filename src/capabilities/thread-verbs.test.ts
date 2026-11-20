// thread.finish as an agent's run reads it: the one who asked (the user
// from a surface, the operator otherwise) and the request to wrap up and
// end the thread itself — one rendering for every runner.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeFinishRequest } from './thread-verbs.ts';

describe('describeFinishRequest', () => {
  test('names who asks and what to do', () => {
    const byUser = describeFinishRequest({ actor: 'user', payload: { reason: 'finished_by_user' } });
    const byParent = describeFinishRequest({ actor: 'agent', payload: { reason: 'finished_by_parent' } });

    assert.match(byUser, /^\[The user asks you to finish this thread\]\n/);
    assert.match(byParent, /^\[Your operator asks you to finish this thread\]\n/);
    assert.match(byUser, /end the thread with end_thread in this turn/);
    assert.match(byUser, /start nothing new/);
  });
});
