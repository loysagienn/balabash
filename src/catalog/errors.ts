// The one error channel of a capability call. The outcome of a call is a
// value of the output type or a CapabilityError; the set of kinds is closed
// and owned by the platform — a kind answers "who fixes it". An author throws
// CapabilityError with a kind; any other exception becomes `internal`.

import type { JsonValue } from './json.ts';

export const ERROR_KINDS = [
  'invalid_input', // the caller: the arguments do not fit the input type or the capability's own conditions
  'unknown_capability', // the caller: no capability with this name in the caller's grant
  'not_found', // the caller: the object an argument points to does not exist
  'conflict', // the caller: the current state does not allow the action
  'auth_required', // the user: the account is not connected or its authorization has expired
  'external_error', // the outside system refused, or answered with something that does not fit the output type
  'unavailable', // the outside system gave no answer; whether the action took effect is unknown
  'internal', // the platform: a defect of the capability or of the platform
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

// The value form of the error: what a program catches, what the journal
// keeps, what a port shows to the model.
export type CapabilityErrorValue = {
  kind: ErrorKind;
  message: string;
  details?: JsonValue;
};

export class CapabilityError extends Error {
  override name = 'CapabilityError';
  kind: ErrorKind;
  details?: JsonValue;

  constructor(kind: ErrorKind, message: string, details?: JsonValue) {
    super(message);
    this.kind = kind;

    if (details !== undefined) {
      this.details = details;
    }
  }

  toValue(): CapabilityErrorValue {
    return { kind: this.kind, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) };
  }
}

function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === 'string' && (ERROR_KINDS as readonly string[]).includes(value);
}

// Whatever was thrown, as a CapabilityError. The class is detected
// structurally, not by instanceof: an installation extension lives outside
// the bundle and may carry its own copy of the class.
export function toCapabilityError(error: unknown): CapabilityError {
  if (error instanceof CapabilityError) {
    return error;
  }

  if (error instanceof Error && error.name === 'CapabilityError' && 'kind' in error && isErrorKind(error.kind)) {
    const details = 'details' in error ? (error.details as JsonValue | undefined) : undefined;

    return new CapabilityError(error.kind, error.message, details);
  }

  return new CapabilityError('internal', error instanceof Error ? error.message : String(error));
}
