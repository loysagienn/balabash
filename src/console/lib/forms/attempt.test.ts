import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attemptAccepted, attemptAfterInput, attemptRefusal, idleForm } from './attempt.ts';

describe('a dialog attempt', () => {
  const refused = { status: 500, code: 'internal', message: 'boom' };

  it('is accepted when the count moved past the submit, whatever the dialog saw at opening', () => {
    assert.equal(attemptAccepted(null, { done: 3 }), false);
    assert.equal(attemptAccepted({ done: 0 }, { done: 0 }), false);
    assert.equal(attemptAccepted({ done: 0 }, { done: 1 }), true);
    // Save A accepted (done 1), then Save B: the second attempt opens at 1
    // and is not over until the count moves again.
    assert.equal(attemptAccepted({ done: 1 }, { done: 1 }), false);
    assert.equal(attemptAccepted({ done: 1 }, { done: 2 }), true);
  });

  it('shows the refusal of its call once it landed, and survives typing during the call', () => {
    const attempt = { done: 0 };

    // Save A → the operator types B while the call runs → the attempt stands.
    const during = attemptAfterInput(attempt, { pending: true });

    assert.deepEqual(during, attempt);
    assert.equal(attemptRefusal(during, { pending: true, error: null }), null);
    // The 500 lands: the refusal shows under B's values.
    assert.deepEqual(attemptRefusal(during, { pending: false, error: refused }), refused);
    // Typing after the refusal dismisses it; the next submit is a new attempt.
    assert.equal(attemptAfterInput(during, { pending: false }), null);
    assert.equal(attemptRefusal(null, { pending: false, error: refused }), null);
    // No attempt — a refusal left in the store from an earlier dialog is not shown.
    assert.equal(attemptRefusal(null, { ...idleForm, error: refused }), null);
  });
});
