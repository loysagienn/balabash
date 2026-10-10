// One call of a form at a time and one submit of a dialog as an attempt —
// the rule shared by every form that changes a registry (the project
// dialogs, the publish dialog of an app). The store keeps a FormCallState
// per form: the call in flight, the refusal of the last call (the dialog
// shows it), how many calls the server accepted. A submit opens an attempt
// — the accepted count at that moment. The attempt is over when the count
// moved (the dialog closes — that very call was accepted) or when the store
// holds a refusal and no call is in flight (the dialog shows it). Input
// typed while the call is still running belongs to the same attempt — its
// answer is still owed, a refusal must show; input typed after a refusal
// dismisses it (a new attempt begins with the next submit). A dialog
// opened while the form's call is still in flight (the previous instance
// was closed before the answer) adopts that call as its attempt: the answer
// is still owed to the operator — a refusal shows, an acceptance closes
// the dialog, and nothing is submitted twice.

import type { ApiFailure } from '../api/index.ts';

export type FormCallState = { pending: boolean; error: ApiFailure | null; done: number };

export const idleForm: FormCallState = { pending: false, error: null, done: 0 };

export type FormAttempt = { done: number };

export function attemptAccepted(attempt: FormAttempt | null, form: Pick<FormCallState, 'done'>): boolean {
  return attempt !== null && form.done !== attempt.done;
}

export function attemptRefusal(attempt: FormAttempt | null, form: Pick<FormCallState, 'pending' | 'error'>): ApiFailure | null {
  return attempt !== null && !form.pending ? form.error : null;
}

export function attemptAfterInput(attempt: FormAttempt | null, form: Pick<FormCallState, 'pending'>): FormAttempt | null {
  return form.pending ? attempt : null;
}

// The attempt a dialog opens with: the call in flight, if any — its done
// count is the one of the submit that sent the call — else none.
export function openAttempt(form: Pick<FormCallState, 'pending' | 'done'>): FormAttempt | null {
  return form.pending ? { done: form.done } : null;
}
