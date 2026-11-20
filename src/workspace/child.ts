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
//   - the SQL child program + queryInChild/sqlInChild/statementInChild — the
//     entry points into workspace.sqlite: free-form SQL (data_query; the
//     capability workspace_query) and a single prepared statement with named
//     binds (app endpoints).

import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { recordProcessGroup } from '../runtime/process-groups.ts';
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
  // last (the workspace command returns the end of each stream).
  capMode?: 'head' | 'tail';
  // Aborting it kills the child's whole group, as the timeout does: the
  // outcome then carries exitCode null and timedOut false.
  signal?: AbortSignal;
  // Register before the workspace command can run. Kill remaining group
  // members on close, or at the next boot if the app exits first.
  ownsGroup?: boolean;
  // Text for the child's standard input, closed after it. Without it the
  // child has no input at all.
  input?: string;
  // Each stream is decoded as one text: a character split between two
  // chunks of a stream is not broken, and the cap never cuts a character
  // written as a surrogate pair.
  wholeCharacters?: boolean;
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

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

export function runChild(command: string, args: string[], options: RunChildOptions): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    // fd 3 gates exec on durable registration. If the app dies before the
    // record exists, EOF ends the starter without running the command.
    const starterArgs = options.ownsGroup
      ? ['-c', 'read -r start <&3 && exec 3<&- && exec "$@"', 'workspace-command', command, ...args]
      : args;
    const child = spawn(options.ownsGroup ? '/bin/sh' : command, starterArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', options.ownsGroup ? 'pipe' : 'ignore'],
      // Own process group: the timeout (and any external sweep) kills the
      // whole tree, not just the direct child.
      detached: true,
    });

    let releaseGroup: (() => void) | undefined;
    if (options.ownsGroup && child.pid !== undefined) {
      const gate = child.stdio[3] as Writable;
      gate.on('error', () => {}); // The starter may already have exited.
      try {
        releaseGroup = recordProcessGroup(child.pid);
        gate.end('start\n');
      } catch (error) {
        gate.destroy();
        child.kill('SIGKILL');
        reject(error);
      }
    }

    if (child.stdin) {
      // A child that died before reading its input closes the pipe: the
      // outcome of the child tells it, not an error of the write.
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, () => child.kill('SIGKILL'));
    }, options.timeoutMs);

    const abort = () => killGroup(child.pid, () => child.kill('SIGKILL'));

    if (options.signal?.aborted) {
      abort();
    } else {
      options.signal?.addEventListener('abort', abort, { once: true });
    }

    const buffers = { stdout: '', stderr: '' };
    const truncated = { stdout: false, stderr: false };
    const tailKeep = options.capMode === 'tail';
    const decoders = options.wholeCharacters
      ? { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
      : null;

    // Keep consuming (so the pipe never backpressures the child), but cap the
    // buffer: head-keep stops buffering past the cap, tail-keep slides the
    // window and keeps only the last maxOutputChars.
    const append = (stream: 'stdout' | 'stderr', text: string) => {
      if (!tailKeep && truncated[stream]) return;
      buffers[stream] += text;
      if (buffers[stream].length > options.maxOutputChars) {
        let kept = tailKeep
          ? buffers[stream].slice(-options.maxOutputChars)
          : buffers[stream].slice(0, options.maxOutputChars);

        // The cut fell inside a surrogate pair: the half goes too.
        if (decoders && tailKeep && isLowSurrogate(kept.charCodeAt(0))) {
          kept = kept.slice(1);
        } else if (decoders && !tailKeep && isHighSurrogate(kept.charCodeAt(kept.length - 1))) {
          kept = kept.slice(0, -1);
        }

        buffers[stream] = kept;
        truncated[stream] = true;
      }
    };

    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      append(stream, decoders ? decoders[stream].write(chunk) : chunk.toString('utf8'));
    };

    // Both are pipes whatever the input is.
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));

    child.once('error', error => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });

    child.once('close', exitCode => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);

      releaseGroup?.();

      if (decoders) {
        // Bytes of a character the stream ended inside.
        append('stdout', decoders.stdout.end());
        append('stderr', decoders.stderr.end());
      }

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
// The SQL child program. One CommonJS source for `node -e`, three modes
// picked by the JSON payload in argv[1]:
//   { mode: 'query', sql }            — data_query: any SQL; a row-returning
//       statement streams rows up to the caps, anything else goes through
//       exec() (multi-statement scripts work) and reports the change count.
//   { mode: 'sql', sql }              — the capability workspace_query
//       (src/tree/workspace.ts): one form of the answer whatever the
//       statement — { rows, truncated, changes }, a blob as its size in
//       data, the cap of the rows counted in bytes of UTF-8. The statements
//       are prepared and run one after another on one connection, each
//       cut where SQLite ends it: a statement may stand on what the one
//       before it created, and a row-returning statement is seen where it
//       stands. What the other mode passes in silence is refused here by
//       name: SQL that holds no statement; a row-returning statement that
//       is not the only one (its rows would be lost) — the refusal says
//       what has already run; a script that leaves its transaction open
//       (closing the connection rolls it back); a first row larger than
//       the byte cap, when the statement wrote nothing. A writing
//       statement whose first row is over the cap has written: it answers
//       with no rows and truncated, not with a refusal.
//   { mode: 'statement', statement, kind, params, readOnly } — an app
//       endpoint: one prepared statement, values bound ONLY as named
//       parameters (no SQL concatenation by construction); kind = run | all
//       | get. readOnly opens the connection read-only (SQLITE_OPEN_READONLY):
//       a write attempt is an SQL error, whatever the statement text says.
// The payload of the third mode arrives on the standard input (argv[1] is
// "-"): an argument of a process holds about 128 KB, a script may be longer.
// Caps arrive via env (SQL_MAX_ROWS / SQL_MAX_BYTES), the database path via
// WORKSPACE_DB, the lock policy via SQL_BUSY_TIMEOUT_MS (src/workspace/
// sqlite.ts: the child is its own process, so it waits for a foreign writer
// synchronously through SQLite's busy handler; the wait stays clear of the
// kill timeout so a lock that outlasts it surfaces as an SQL error). Row
// values are wire-safed in the child: blobs become placeholders, bigints
// become numbers. A refusal the child words itself is { sqlError }; `locked`
// marks the one that is a lock outlasting the wait rather than the SQL.
// ---------------------------------------------------------------------------

const SQL_RUNNER = `
const { DatabaseSync } = require('node:sqlite');
const payload = JSON.parse(process.argv[1] === '-' ? require('node:fs').readFileSync(0, 'utf8') : process.argv[1]);
const maxRows = Number(process.env.SQL_MAX_ROWS);
const maxBytes = Number(process.env.SQL_MAX_BYTES);
const blobValue = payload.mode === 'sql'
  ? size => ({ blobSizeBytes: size })
  : size => '<blob ' + size + ' bytes>';
const cleanRow = row => {
  const clean = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (value instanceof Uint8Array) clean[key] = blobValue(value.byteLength);
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
// A refusal of the SQL as given, worded for the one who wrote it.
const refuse = message => Object.assign(new Error(message), { refusal: true });
// The rows of the capability's answer: as many whole rows as the caps take,
// the size counted in bytes of the JSON as UTF-8 — the first row too.
const rowsWithinCaps = iterator => {
  const rows = [];
  let bytes = 2;
  let truncated = false;
  for (const row of iterator) {
    if (rows.length >= maxRows) { truncated = true; break; }
    const clean = cleanRow(row);
    const size = Buffer.byteLength(JSON.stringify(clean)) + (rows.length > 0 ? 1 : 0);
    if (bytes + size > maxBytes) { truncated = true; break; }
    rows.push(clean);
    bytes += size;
  }
  return { rows, truncated };
};
// The next statement of a script, from a position of its text: the prepared
// statement and where its text ends — null when nothing but blanks and
// comments is left. The end is SQLite's own (the text of a prepared
// statement is the part of the input it took), so a semicolon in a string,
// a comment or the body of a trigger ends nothing. prepare() reads its whole
// input, and a script of many statements would be read again for each of
// them: the statement is prepared from a window of the text, widened until
// the statement ends inside it — a statement that ends before the end of
// its input ended at its own semicolon, whatever follows.
const SCRIPT_WINDOW = 4096;
const nextStatement = (db, sql, at) => {
  for (let size = SCRIPT_WINDOW; ; size *= 4) {
    const whole = at + size >= sql.length;
    const piece = whole ? sql.slice(at) : sql.slice(at, at + size);
    let stmt;
    let text;
    try {
      stmt = db.prepare(piece);
    } catch (error) {
      if (whole) throw error;
      continue;
    }
    try {
      text = stmt.sourceSQL;
    } catch (error) {
      // prepare() of blank or comment-only text gives a finalized statement.
      if (!(error && error.code === 'ERR_INVALID_STATE')) throw error;
      if (whole) return null;
      continue;
    }
    if (whole || text.length < piece.length) return { stmt, end: at + text.length };
  }
};
const totalChanges = db => Number(db.prepare('SELECT total_changes() AS c').get().c);
// What a script that stops at the statement of a given index (from 0) has
// already done.
const alreadyRun = (db, index) => {
  if (index === 0) return 'Nothing has run.';
  const before = index === 1 ? 'Statement 1 has run' : 'Statements 1–' + index + ' have run';
  if (db.isTransaction) return before + '; the transaction the script opened is rolled back, what ran before it is kept.';
  return before + (index === 1 ? ' and what it changed is kept: do not run it again.' : ' and what they changed is kept: do not run them again.');
};
const runScript = (db, sql) => {
  if (sql.includes('\\0')) throw refuse('The SQL holds a NUL character.');
  const changesBefore = totalChanges(db);
  let at = 0;
  let index = 0;
  for (;;) {
    let next;
    try {
      next = nextStatement(db, sql, at);
    } catch (error) {
      throw atStatement(db, error, index);
    }
    if (next === null) break;
    if (next.stmt.columns().length > 0) {
      let follows = true;
      try { follows = nextStatement(db, sql, next.end) !== null; } catch (error) { /* text that does not prepare is still a statement */ }
      if (index > 0 || follows) {
        throw refuse('Statement ' + (index + 1) + ' returns rows, and several statements go in one call only when none of them returns rows. ' + alreadyRun(db, index) + ' Run the row-returning statement in a call of its own.');
      }
      const { rows, truncated } = rowsWithinCaps(next.stmt.iterate());
      if (rows.length === 0 && truncated && totalChanges(db) === changesBefore) {
        throw refuse('The first row alone is larger than the cap of ' + maxBytes + ' bytes: select fewer columns or shorter values (substr, length).');
      }
      return { rows, truncated, changes: null };
    }
    try {
      next.stmt.run();
    } catch (error) {
      throw atStatement(db, error, index);
    }
    at = next.end;
    index += 1;
  }
  if (index === 0) throw refuse('The SQL holds no statement.');
  if (db.isTransaction) {
    throw refuse('The script leaves a transaction open (a BEGIN without its COMMIT): it is rolled back, and nothing the script did after the BEGIN is kept.');
  }
  return { rows: null, truncated: false, changes: totalChanges(db) - changesBefore };
};
// A failure of a statement that is not the first: the one who reads it
// learns which statement it was and what stands before it.
const atStatement = (db, error, index) => {
  if (index === 0 || !error || typeof error.message !== 'string') return error;
  const code = error.errcode;
  const busy = typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6);
  if (!busy) error.message = 'Statement ' + (index + 1) + ': ' + error.message + '. ' + alreadyRun(db, index);
  else error.afterStatements = alreadyRun(db, index);
  return error;
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
  } else if (payload.mode === 'sql') {
    out = runScript(db, payload.sql);
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
  // SQLite's busy family by its result code (5 SQLITE_BUSY, 6 SQLITE_LOCKED,
  // in the low byte), as isBusyError reads it; the words alone would take
  // SQL that merely mentions them for a lock. The two older modes word
  // their refusal by the words, as they always did.
  const code = error && error.errcode;
  const locked = typeof code === 'number'
    ? (code & 0xff) === 5 || (code & 0xff) === 6
    : !(error && error.refusal) && /database is locked/i.test(message);
  if (payload.mode === 'sql' ? locked : /database is locked/i.test(message)) {
    message += ' (another writer held workspace.sqlite for more than ' +
      Math.round(Number(process.env.SQL_BUSY_TIMEOUT_MS) / 1000) + 's; retry once it commits)';
  }
  if (error && error.afterStatements) message += ' ' + error.afterStatements;
  process.stdout.write(JSON.stringify({ sqlError: message, locked }));
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
  // locked: not the SQL — another writer held the database for the whole wait.
  | { status: 'sql_error'; message: string; locked: boolean }
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
  const viaInput = payload.mode === 'sql';
  const outcome = await runChild(process.execPath, ['-e', SQL_RUNNER, viaInput ? '-' : JSON.stringify(payload)], {
    cwd,
    env: childEnv(dbPath, {
      SQL_MAX_ROWS: String(caps.maxRows),
      SQL_MAX_BYTES: String(caps.maxBytes),
      SQL_BUSY_TIMEOUT_MS: String(childBusyTimeoutMs(caps.timeoutMs)),
    }),
    timeoutMs: caps.timeoutMs,
    // The runner emits at most ~maxBytes of rows plus envelope; leave headroom.
    maxOutputChars: caps.maxBytes * 4,
    ...(viaInput ? { input: JSON.stringify(payload) } : {}),
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
    return { status: 'sql_error', message: parsed.sqlError, locked: parsed.locked === true };
  }

  return { status: 'ok', result: parsed };
}

/** Free-form SQL (the data_query shape) against workspace.sqlite, in a child. */
export function queryInChild(dbPath: string, cwd: string, sql: string, caps: SqlCaps): Promise<SqlChildResult> {
  return runSql(dbPath, cwd, { mode: 'query', sql }, caps);
}

/**
 * Free-form SQL in the form of the capability workspace_query, in a child:
 * the result is { rows, truncated, changes } — rows (a blob as
 * { blobSizeBytes }) and changes null for a row-returning statement, rows
 * null and the change count for anything else.
 */
export function sqlInChild(dbPath: string, cwd: string, sql: string, caps: SqlCaps): Promise<SqlChildResult> {
  return runSql(dbPath, cwd, { mode: 'sql', sql }, caps);
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
