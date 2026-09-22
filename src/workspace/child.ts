// Child-process machinery of the workspace: heavy or untrusted work runs in
// a spawned process — kill-on-timeout works and the synchronous DatabaseSync
// never blocks the app's event loop. Extracted from the workbench tool
// servers (tools/workspace_shared.ts / tools/workspace.ts) so the core can
// reuse it: the apps data gateway (src/apps) executes manifest-declared
// statements through the same runner as data_query — one SQL-in-a-child
// implementation, not a copy.
//
// Two layers here:
//   - runChild/childEnv — generic spawn-with-caps (also used by run_script);
//   - the SQL child program + queryInChild/statementInChild — the two entry
//     points into workspace.sqlite: free-form SQL (data_query) and a single
//     prepared statement with named binds (app endpoints).

import { spawn } from 'node:child_process';
import { childBusyTimeoutMs } from './sqlite.ts';

// ---------------------------------------------------------------------------
// Generic child execution.
// ---------------------------------------------------------------------------

// The child sees a minimal environment, not the app's secrets.
export function childEnv(dbPath: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};

  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }

  return { ...env, WORKSPACE_DB: dbPath, ...extra };
}

export type ChildOutcome = {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
};

export type RunChildOptions = {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputChars: number;
  // 'head' (default) keeps the first maxOutputChars of a stream, 'tail' the
  // last — job journals want the end of a long log, not its beginning.
  capMode?: 'head' | 'tail';
  // Called once after a successful spawn with the child's pid (equal to the
  // process-group id — children run detached in their own group). Lets the
  // caller register the group for an external kill (shutdown sweep).
  onSpawn?: (pid: number) => void;
};

// Kill the child's whole process group: `bash -c` (and scripts generally)
// spawn grandchildren, and killing only the direct child would orphan them.
// The child is detached into its own group, so -pid addresses all of it.
function killGroup(pid: number | undefined, fallback: () => void): void {
  if (pid === undefined) {
    fallback();
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    fallback();
  }
}

export function runChild(command: string, args: string[], options: RunChildOptions): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group: the timeout (and any external sweep) kills the
      // whole tree, not just the direct child.
      detached: true,
    });

    if (child.pid !== undefined) {
      options.onSpawn?.(child.pid);
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, () => child.kill('SIGKILL'));
    }, options.timeoutMs);

    const buffers = { stdout: '', stderr: '' };
    const truncated = { stdout: false, stderr: false };
    const tailKeep = options.capMode === 'tail';

    // Keep consuming (so the pipe never backpressures the child), but cap the
    // buffer: head-keep stops buffering past the cap, tail-keep slides the
    // window and keeps only the last maxOutputChars.
    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (!tailKeep && truncated[stream]) return;
      buffers[stream] += chunk.toString('utf8');
      if (buffers[stream].length > options.maxOutputChars) {
        buffers[stream] = tailKeep
          ? buffers[stream].slice(-options.maxOutputChars)
          : buffers[stream].slice(0, options.maxOutputChars);
        truncated[stream] = true;
      }
    };

    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));

    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('close', exitCode => {
      clearTimeout(timer);
      resolve({
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: buffers.stdout,
        stdoutTruncated: truncated.stdout,
        stderr: buffers.stderr,
        stderrTruncated: truncated.stderr,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The SQL child program. One CommonJS source for `node -e`, two modes picked
// by the JSON payload in argv[1]:
//   { mode: 'query', sql }            — data_query: any SQL; a row-returning
//       statement streams rows up to the caps, anything else goes through
//       exec() (multi-statement scripts work) and reports the change count.
//   { mode: 'statement', statement, kind, params, readOnly } — an app
//       endpoint: one prepared statement, values bound ONLY as named
//       parameters (no SQL concatenation by construction); kind = run | all
//       | get. readOnly opens the connection read-only (SQLITE_OPEN_READONLY):
//       a write attempt is an SQL error, whatever the statement text says.
// Caps arrive via env (SQL_MAX_ROWS / SQL_MAX_BYTES), the database path via
// WORKSPACE_DB, the lock policy via SQL_BUSY_TIMEOUT_MS (src/workspace/
// sqlite.ts: the child is its own process, so it waits for a foreign writer
// synchronously through SQLite's busy handler; the wait stays clear of the
// kill timeout so a lock that outlasts it surfaces as an SQL error). Row
// values are wire-safed in the child: blobs become placeholders, bigints
// become numbers.
// ---------------------------------------------------------------------------

const SQL_RUNNER = `
const { DatabaseSync } = require('node:sqlite');
const payload = JSON.parse(process.argv[1]);
const maxRows = Number(process.env.SQL_MAX_ROWS);
const maxBytes = Number(process.env.SQL_MAX_BYTES);
const cleanRow = row => {
  const clean = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (value instanceof Uint8Array) clean[key] = '<blob ' + value.byteLength + ' bytes>';
    else if (typeof value === 'bigint') clean[key] = Number(value);
    else clean[key] = value;
  }
  return clean;
};
const collectRows = iterator => {
  const rows = [];
  let bytes = 2;
  let truncated = false;
  for (const row of iterator) {
    if (rows.length >= maxRows) { truncated = true; break; }
    const clean = cleanRow(row);
    const encoded = JSON.stringify(clean);
    if (rows.length > 0 && bytes + encoded.length > maxBytes) { truncated = true; break; }
    rows.push(clean);
    bytes += encoded.length + 1;
  }
  return { rows, truncated };
};
try {
  const db = new DatabaseSync(process.env.WORKSPACE_DB, {
    timeout: Number(process.env.SQL_BUSY_TIMEOUT_MS),
    readOnly: payload.readOnly === true,
  });
  let out;
  if (payload.mode === 'statement') {
    const stmt = db.prepare(payload.statement);
    if (payload.kind === 'run') {
      const info = stmt.run(payload.params);
      out = { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
    } else if (payload.kind === 'get') {
      const row = stmt.get(payload.params);
      out = { row: row === undefined ? null : cleanRow(row) };
    } else {
      const { rows, truncated } = collectRows(stmt.iterate(payload.params));
      out = { rows, rowCount: rows.length, truncated };
    }
  } else {
    const stmt = db.prepare(payload.sql);
    if (stmt.columns().length > 0) {
      const { rows, truncated } = collectRows(stmt.iterate());
      out = { rows, rowCount: rows.length, truncated };
      if (truncated) out.note = 'Result truncated (caps: ' + maxRows + ' rows / ~' + maxBytes + ' bytes). Narrow with WHERE/LIMIT/OFFSET or aggregate.';
    } else {
      const before = db.prepare('SELECT total_changes() AS c').get().c;
      db.exec(payload.sql);
      const after = db.prepare('SELECT total_changes() AS c').get().c;
      out = { ok: true, changes: after - before };
    }
  }
  process.stdout.write(JSON.stringify(out));
} catch (error) {
  let message = String((error && error.message) || error);
  if (/database is locked/i.test(message)) {
    message += ' (another writer held workspace.sqlite for more than ' +
      Math.round(Number(process.env.SQL_BUSY_TIMEOUT_MS) / 1000) + 's; retry once it commits)';
  }
  process.stdout.write(JSON.stringify({ sqlError: message }));
  process.exitCode = 3;
}
`;

export type SqlCaps = {
  maxRows: number;
  maxBytes: number;
  timeoutMs: number;
};

// The neutral outcome: the edges own their error shapes (ToolError on the
// tools' wire, HTTP JSON on the apps gateway) — this layer only names what
// happened.
export type SqlChildResult =
  | { status: 'ok'; result: Record<string, unknown> }
  | { status: 'timeout' }
  | { status: 'sql_error'; message: string }
  | { status: 'failed'; exitCode: number | null; stderr: string };

/** A JSON-representable value bindable as a named SQL parameter. */
export type SqlParamValue = string | number | boolean | null;

export type SqlStatementCall = {
  statement: string;
  kind: 'run' | 'all' | 'get';
  /** Every bind by name; an optional-and-absent parameter arrives as null. */
  params: Record<string, SqlParamValue>;
  /**
   * Open the connection read-only: the statement cannot write no matter
   * what it says (the bulk window of app endpoints runs this way).
   */
  readOnly?: boolean;
};

async function runSql(
  dbPath: string,
  cwd: string,
  payload: Record<string, unknown>,
  caps: SqlCaps,
): Promise<SqlChildResult> {
  const outcome = await runChild(process.execPath, ['-e', SQL_RUNNER, JSON.stringify(payload)], {
    cwd,
    env: childEnv(dbPath, {
      SQL_MAX_ROWS: String(caps.maxRows),
      SQL_MAX_BYTES: String(caps.maxBytes),
      SQL_BUSY_TIMEOUT_MS: String(childBusyTimeoutMs(caps.timeoutMs)),
    }),
    timeoutMs: caps.timeoutMs,
    // The runner emits at most ~maxBytes of rows plus envelope; leave headroom.
    maxOutputChars: caps.maxBytes * 4,
  });

  if (outcome.timedOut) {
    return { status: 'timeout' };
  }

  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(outcome.stdout) as Record<string, unknown>;
  } catch {
    return { status: 'failed', exitCode: outcome.exitCode, stderr: outcome.stderr };
  }

  if (typeof parsed.sqlError === 'string') {
    return { status: 'sql_error', message: parsed.sqlError };
  }

  return { status: 'ok', result: parsed };
}

/** Free-form SQL (the data_query shape) against workspace.sqlite, in a child. */
export function queryInChild(dbPath: string, cwd: string, sql: string, caps: SqlCaps): Promise<SqlChildResult> {
  return runSql(dbPath, cwd, { mode: 'query', sql }, caps);
}

/**
 * One declared app endpoint against workspace.sqlite, in a child: a single
 * prepared statement with named binds. The result shape by kind:
 * run → {changes, lastInsertRowid}; all → {rows, rowCount, truncated};
 * get → {row} (null when no row matched).
 */
export function statementInChild(
  dbPath: string,
  cwd: string,
  call: SqlStatementCall,
  caps: SqlCaps,
): Promise<SqlChildResult> {
  return runSql(dbPath, cwd, { mode: 'statement', ...call, readOnly: call.readOnly === true }, caps);
}
