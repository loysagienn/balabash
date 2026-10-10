// The pure rules of the secret entry screen (Secrets.tsx): what the card
// is called, which required fields are still empty, what goes to the
// server, and how an answer of the API reads — the row of a one-time link
// dies on fulfilment, so a 404 means "used or expired", not "wrong URL".

import type { SecretRequestField, SecretRequestView } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';

export type SecretValues = Record<string, string>;
export type SecretErrors = Record<string, string>;

export const REQUIRED_ERROR = 'Required.';

export function secretsTitle(request: Pick<SecretRequestView, 'kind' | 'server'>): string {
  return request.kind === 'oauth-client' ? `OAuth client for ${request.server}` : `Secrets for ${request.server}`;
}

// The form's own check before the call: a required field with nothing but
// whitespace in it is empty — the server would refuse the same way.
export function missingRequired(fields: SecretRequestField[], values: SecretValues): SecretErrors {
  const errors: SecretErrors = {};

  for (const field of fields) {
    if (field.required && !(values[field.key] ?? '').trim()) {
      errors[field.key] = REQUIRED_ERROR;
    }
  }

  return errors;
}

// The body of the POST: every field of the request, trimmed — a token
// pasted with a stray space or newline is the token. Fields the request
// did not ask for are not sent (the server refuses an unexpected key).
export function provisionValues(fields: SecretRequestField[], values: SecretValues): SecretValues {
  const body: SecretValues = {};

  for (const field of fields) {
    body[field.key] = (values[field.key] ?? '').trim();
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

export function submitLabel(busy: boolean): string {
  return busy ? 'Saving' : 'Save';
}
