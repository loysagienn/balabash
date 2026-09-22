// The data gateway of an app: executes ONE endpoint declared in the app's
// manifest against the owner's workspace.sqlite. The api section IS the
// app's whole runtime perimeter (design.md §3, decision №13): the platform
// never executes anything beyond a declared statement — no ad-hoc SQL, no
// DDL, and the shared child runner prepares exactly one statement (a
// trailing ';…' tail is never compiled).
//
// Values travel ONLY as named bind parameters — SQL concatenation does not
// exist by construction. Params are validated here against the manifest's
// types (string | number | boolean, '?' = optional; optional-and-absent
// binds as NULL), so the child sees a fully typed, closed set of binds.

import { statementInChild, type SqlCaps, type SqlChildResult, type SqlParamValue } from '../workspace/child.ts';
import { workspaceDbPath, workspaceFilesDir } from '../workspace/layout.ts';
import type { AppEndpoint } from './manifest.ts';

// Endpoint caps: the same result window and timeout as data_query. The
// timeout is not a statement budget (an endpoint statement is instant) but
// the lock window of src/workspace/sqlite.ts: a write endpoint must outwait
// a foreign writer's transaction on the shared workspace.sqlite (tens of
// seconds) instead of failing the UI with "database is locked"; reads never
// wait under WAL.
const ENDPOINT_MAX_ROWS = 200;
const ENDPOINT_MAX_BYTES = 50_000;
const ENDPOINT_TIMEOUT_MS = 60_000;

// The bulk window: an endpoint the manifest marks `bulk: true` may hand a
// whole dataset to the browser (a point cloud of every polling station, a
// map layer) instead of a 200-row slice. It is an exception with its own
// fences, not a wider default:
//   - opt-in per endpoint, and only for kind 'all' (manifest.ts);
//   - the statement runs on a READ-ONLY connection — a bulk endpoint cannot
//     write, whatever its text says (child.ts, SQLITE_OPEN_READONLY);
//   - the ceiling below is a hard one: rows past it are dropped silently,
//     exactly like the ordinary window (the SDK contract has no truncation
//     signal); 16 MB of JSON is the most the platform buffers per call;
//   - at most BULK_MAX_IN_FLIGHT bulk calls run at once, process-wide: a
//     burst of bulk requests (the public gateway lets 240 hits/min per IP
//     through) answers 'busy' instead of multiplying multi-megabyte buffers;
//   - the same timeout — a bulk statement is seconds at most, and the wait
//     is the lock window like everywhere else.
// The gateway gzips large results on the way out (wire.ts), so the wire
// cost of a bulk answer is a fraction of its JSON size.
export const BULK_MAX_ROWS = 200_000;
export const BULK_MAX_BYTES = 16_000_000;
export const BULK_MAX_IN_FLIGHT = 2;

export type EndpointCallOutcome =
  | { status: 'ok'; result: unknown }
  | { status: 'bad_params'; message: string }
  | { status: 'busy'; message: string }
  | { status: 'error'; message: string };

/** The result window an endpoint runs under: the ordinary slice or bulk. */
export function endpointCaps(endpoint: Pick<AppEndpoint, 'bulk'>): SqlCaps {
  if (endpoint.bulk) {
    return { maxRows: BULK_MAX_ROWS, maxBytes: BULK_MAX_BYTES, timeoutMs: ENDPOINT_TIMEOUT_MS };
  }

  return { maxRows: ENDPOINT_MAX_ROWS, maxBytes: ENDPOINT_MAX_BYTES, timeoutMs: ENDPOINT_TIMEOUT_MS };
}

// ---------------------------------------------------------------------------
// The bulk concurrency fence: a counting semaphore without a queue. A call
// that finds every slot taken is refused right away (the edge answers 503
// with Retry-After) — queueing multi-megabyte work behind other
// multi-megabyte work would only pile memory up.
// ---------------------------------------------------------------------------

export class BulkSlots {
  private inFlight = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  /** Runs fn inside a slot; {taken: false} when no slot is free right now. */
  async run<T>(fn: () => Promise<T>): Promise<{ taken: true; value: T } | { taken: false }> {
    if (this.inFlight >= this.max) {
      return { taken: false };
    }

    this.inFlight += 1;

    try {
      return { taken: true, value: await fn() };
    } finally {
      this.inFlight -= 1;
    }
  }

  get active(): number {
    return this.inFlight;
  }
}

const bulkSlots = new BulkSlots(BULK_MAX_IN_FLIGHT);

// ---------------------------------------------------------------------------
// Param validation against the manifest's declared types.
// ---------------------------------------------------------------------------

type ParamCheck = { ok: true; binds: Record<string, SqlParamValue> } | { ok: false; message: string };

function checkParams(endpoint: AppEndpoint, supplied: Record<string, unknown>): ParamCheck {
  const declared = endpoint.params;
  const problems: string[] = [];
  const binds: Record<string, SqlParamValue> = {};

  for (const name of Object.keys(supplied)) {
    if (!(name in declared)) {
      problems.push(`"${name}" is not a declared parameter`);
    }
  }

  for (const [name, declaredType] of Object.entries(declared)) {
    const optional = declaredType.endsWith('?');
    const baseType = optional ? declaredType.slice(0, -1) : declaredType;
    const value = supplied[name];

    if (value === undefined || value === null) {
      if (!optional) {
        problems.push(`"${name}" (${baseType}) is required`);
      } else {
        binds[name] = null;
      }

      continue;
    }

    if (typeof value !== baseType || (baseType === 'number' && !Number.isFinite(value))) {
      problems.push(`"${name}" must be a ${baseType}`);

      continue;
    }

    binds[name] = value as SqlParamValue;
  }

  if (problems.length) {
    return { ok: false, message: `Invalid params: ${problems.join('; ')}` };
  }

  return { ok: true, binds };
}

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

/**
 * Runs one declared endpoint of userId's app. The result shape follows the
 * SDK contract (sdk/data.ts): rows for 'all', one row or null for 'get',
 * {changes, lastInsertRowid} for 'run'. 'bad_params' is the caller's 400;
 * 'busy' is the bulk fence (503, retry later); 'error' is an execution
 * failure (the owner edge may show the message, the public edge must not).
 */
export async function callAppEndpoint(
  userId: string,
  endpoint: AppEndpoint,
  suppliedParams: Record<string, unknown>,
): Promise<EndpointCallOutcome> {
  const checked = checkParams(endpoint, suppliedParams);

  if (!checked.ok) {
    return { status: 'bad_params', message: checked.message };
  }

  const execute = () =>
    statementInChild(
      workspaceDbPath(userId),
      workspaceFilesDir(userId),
      { statement: endpoint.statement, kind: endpoint.kind, params: checked.binds, readOnly: endpoint.bulk },
      endpointCaps(endpoint),
    );

  let outcome: SqlChildResult;

  if (endpoint.bulk) {
    const slot = await bulkSlots.run(execute);

    if (!slot.taken) {
      return {
        status: 'busy',
        message: `Too many bulk endpoint calls in flight (limit ${BULK_MAX_IN_FLIGHT}); retry in a moment`,
      };
    }

    outcome = slot.value;
  } else {
    outcome = await execute();
  }

  switch (outcome.status) {
    case 'ok': {
      // Unwrap to the SDK contract; rows stay silently capped at the window
      // (the authoring convention tells agents lists cap at 200 rows, or at
      // the bulk ceiling for bulk endpoints).
      if (endpoint.kind === 'all') {
        return { status: 'ok', result: outcome.result.rows };
      }

      if (endpoint.kind === 'get') {
        return { status: 'ok', result: outcome.result.row };
      }

      return { status: 'ok', result: outcome.result };
    }
    case 'timeout':
      return { status: 'error', message: `The statement timed out after ${ENDPOINT_TIMEOUT_MS / 1000}s` };
    case 'sql_error':
      return { status: 'error', message: outcome.message };
    case 'failed':
      return { status: 'error', message: 'The statement executor failed' };
  }
}
