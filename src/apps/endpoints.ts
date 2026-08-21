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

import { statementInChild, type SqlParamValue } from '../workspace/child.ts';
import { workspaceDbPath, workspaceFilesDir } from '../workspace/layout.ts';
import type { AppEndpoint } from './manifest.ts';

// Endpoint caps: the same result window as data_query, but a shorter
// timeout — endpoint calls are interactive UI traffic, not analysis.
const ENDPOINT_MAX_ROWS = 200;
const ENDPOINT_MAX_BYTES = 50_000;
const ENDPOINT_TIMEOUT_MS = 10_000;

export type EndpointCallOutcome =
  | { status: 'ok'; result: unknown }
  | { status: 'bad_params'; message: string }
  | { status: 'error'; message: string };

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
 * 'error' is an execution failure (the owner edge may show the message, the
 * public edge must not).
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

  const outcome = await statementInChild(
    workspaceDbPath(userId),
    workspaceFilesDir(userId),
    { statement: endpoint.statement, kind: endpoint.kind, params: checked.binds },
    { maxRows: ENDPOINT_MAX_ROWS, maxBytes: ENDPOINT_MAX_BYTES, timeoutMs: ENDPOINT_TIMEOUT_MS },
  );

  switch (outcome.status) {
    case 'ok': {
      // Unwrap to the SDK contract; rows stay silently capped at the window
      // (the authoring convention tells agents lists cap at 200 rows).
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
