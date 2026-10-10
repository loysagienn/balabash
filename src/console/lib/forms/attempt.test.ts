import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attemptAccepted, attemptAfterInput, attemptRefusal, idleForm, openAttempt } from './attempt.ts';
import type { FormAttempt, FormCallState } from './attempt.ts';

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

  it('opens over a call in flight by adopting it; an idle form opens without an attempt', () => {
    assert.equal(openAttempt(idleForm), null);
    assert.equal(openAttempt({ pending: false, done: 2 }), null);
    assert.deepEqual(openAttempt({ pending: true, done: 2 }), { done: 2 });
  });

  it('lifecycle: submit, close before the answer, open again — the answer lands in the new instance, nothing is submitted twice', () => {
    // The store's form and a scripted dialog instance: `submit` opens an
    // attempt the way the dialogs do (a submit while pending sends nothing).
    let form: FormCallState = idleForm;
    const submits: number[] = [];
    const instance = () => {
      let attempt: FormAttempt | null = openAttempt(form);

      return {
        submit() {
          if (form.pending) {
            return;
          }

          attempt = { done: form.done };
          submits.push(form.done);
          form = { ...form, pending: true, error: null };
        },
        accepted: () => attemptAccepted(attempt, form),
        refusal: () => attemptRefusal(attempt, form),
      };
    };

    // First instance submits, then is closed (Escape, the scrim) while the call runs.
    const first = instance();

    first.submit();
    assert.deepEqual(submits, [0]);

    // Opened again before the answer: the new instance owns the call.
    const second = instance();

    assert.equal(second.accepted(), false);
    assert.equal(second.refusal(), null);
    second.submit();
    assert.deepEqual(submits, [0], 'a submit while the call runs sends nothing');

    // The call is accepted: the new instance closes — and the first, had it stayed, would too.
    form = { pending: false, error: null, done: 1 };
    assert.equal(second.accepted(), true);
    assert.equal(first.accepted(), true);

    // A third instance over the idle form opens fresh: nothing to adopt, nothing accepted.
    const third = instance();

    assert.equal(third.accepted(), false);
    assert.equal(third.refusal(), null);

    // The same reopening when the call is refused: the refusal shows in the new instance.
    third.submit();
    assert.deepEqual(submits, [0, 1]);
    const fourth = instance();

    form = { pending: false, error: refused, done: 1 };
    assert.equal(fourth.accepted(), false);
    assert.deepEqual(fourth.refusal(), refused);
    // Typing after it dismisses the refusal; opened once more over the idle form — no refusal is shown.
    assert.equal(attemptAfterInput({ done: 1 }, form), null);
    assert.equal(instance().refusal(), null);
  });
});
