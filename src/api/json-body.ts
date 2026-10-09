// The JSON body of a mutation request, read strictly: an empty body is an
// empty object (a "touch", a cancel without a reason), a JSON object is
// taken as is, and anything else — malformed JSON, an array, null, a scalar
// — is a refusal, never an empty object. Before this rule a corrupted PATCH
// /projects/:id turned into a successful touch (updatedAt bumped, an event
// journaled) instead of a 400. Pure: the transport (src/api/api.ts) reads
// the stream and answers the status.

import { parseJson } from '../utils/serialize-json.ts';

export type JsonBody = { ok: true; body: Record<string, unknown> } | { ok: false; message: string };

export function parseJsonBody(raw: string): JsonBody {
  if (!raw.trim()) {
    return { ok: true, body: {} };
  }

  let parsed: unknown;

  try {
    parsed = parseJson(raw);
  } catch {
    return { ok: false, message: 'the body is not valid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'the body must be a JSON object' };
  }

  return { ok: true, body: parsed as Record<string, unknown> };
}
