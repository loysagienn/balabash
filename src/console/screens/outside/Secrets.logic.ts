// The pure rules of the secret entry screen (Secrets.tsx): what the card
// is called, which required fields are still empty, what goes to the
// server, how an answer of the API reads, what the screen remembers about
// one request id, and how one submit lives. The row of a one-time link
// dies on fulfilment, so a 404 means "used or expired", not "wrong URL".

import type { SecretRequestField, SecretRequestResponse, SecretRequestView } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';

export type SecretValues = Record<string, string>;
export type SecretErrors = Record<string, string>;

export const REQUIRED_ERROR = 'Required.';

export function secretsTitle(request: Pick<SecretRequestView, 'kind' | 'server'>): string {
  return request.kind === 'oauth-client' ? `OAuth client for ${request.server}` : `Secrets for ${request.server}`;
}

// The form's own check before the call: a required field with nothing but
// whitespace in it is empty — the server refuses the same way for both
// kinds of request.
export function missingRequired(fields: SecretRequestField[], values: SecretValues): SecretErrors {
  const errors: SecretErrors = {};

  for (const field of fields) {
    if (field.required && !(values[field.key] ?? '').trim()) {
      errors[field.key] = REQUIRED_ERROR;
    }
  }

  return errors;
}

// The body of the POST: every field of the request, as typed — the server
// owns the value: an external secret is stored byte for byte (a space at
// the edge may be part of a password), an OAuth client is trimmed there.
// Fields the request did not ask for are not sent (the server refuses an
// unexpected key).
export function provisionValues(fields: SecretRequestField[], values: SecretValues): SecretValues {
  const body: SecretValues = {};

  for (const field of fields) {
    body[field.key] = values[field.key] ?? '';
  }

  return body;
}

// How the screen reads a failed call: the row is gone (404 — used by an
// earlier submit, another tab, or never issued by this Balabash) → the
// "Link expired" card; the session is gone (401 — the fetch layer has
// already told the store, the sign-in card is on its way) → nothing to
// show; anything else → the message, in place.
export type SecretsFailure = { kind: 'expired' } | { kind: 'session' } | { kind: 'failed'; message: string };

export function secretsFailure(error: ApiFailure): SecretsFailure {
  if (error.status === 404) {
    return { kind: 'expired' };
  }
  if (error.status === 401) {
    return { kind: 'session' };
  }

  return { kind: 'failed', message: error.message };
}

// What the screen knows about one request id — the data of the query
// ['secret-request', id]: the form's metadata while the row lives, or the
// outcome that ended it. It carries no value ever typed: a remount, a
// return by history or a second tab of the same id finds the outcome, not
// a form that would post once more to a dead row.
export type SecretRequestState = { kind: 'form'; request: SecretRequestView } | { kind: 'saved'; server: string | null } | { kind: 'expired' };

export function secretRequestKey(id: string): ['secret-request', string] {
  return ['secret-request', id];
}

export function requestState(response: SecretRequestResponse): SecretRequestState {
  return { kind: 'form', request: response.request };
}

// A failed GET that is an answer, not an error: the row is gone.
export function requestStateOfFailure(error: ApiFailure): SecretRequestState | null {
  return secretsFailure(error).kind === 'expired' ? { kind: 'expired' } : null;
}

// What the cache holds for the id once its POST has settled: success and a
// 404 end the row — whatever instance shows this id next reads the card
// from here; an outcome that is already final stays; a refusal the
// operator can fix (400, network) and a lost session change nothing —
// `undefined` is "leave it as it is".
export function afterProvision(current: SecretRequestState | undefined, outcome: SecretsFailure | null): SecretRequestState | undefined {
  if (current?.kind === 'saved') {
    return undefined;
  }
  if (outcome === null) {
    return { kind: 'saved', server: current?.kind === 'form' ? current.request.server : null };
  }
  if (outcome.kind === 'expired') {
    return current?.kind === 'expired' ? undefined : { kind: 'expired' };
  }

  return undefined;
}

// One submit of the form, kept as the identity of the call in flight (the
// sign-in form's rule, SignIn.logic.ts): the answer is applied only when
// it belongs to the submission still pending — a late answer of an earlier
// submit, or of another instance, changes nothing here. The values
// themselves never enter this state: they travel in the call and die with
// it.
export type Submission = { id: string };

export type SaveState = {
  submission: Submission | null;
  // A refusal of the server that belongs to the whole form, for another try.
  failure: string | null;
};

export type SaveAction = { type: 'submit'; submission: Submission } | { type: 'settled'; submission: Submission; outcome: SecretsFailure | null };

export const SAVE_IDLE: SaveState = { submission: null, failure: null };

export function reduceSave(state: SaveState, action: SaveAction): SaveState {
  switch (action.type) {
    case 'submit':
      // One call at a time: a second submit while one is in flight is not a call.
      return state.submission ? state : { submission: action.submission, failure: null };
    case 'settled':
      if (action.submission !== state.submission) {
        return state;
      }

      // Success and a 404 are read from the cache (afterProvision); a lost
      // session is the sign-in card's; only a fixable refusal stays here.
      return { submission: null, failure: action.outcome?.kind === 'failed' ? action.outcome.message : null };
  }
}

export function submitLabel(busy: boolean): string {
  return busy ? 'Saving' : 'Save';
}
