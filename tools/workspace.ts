// Workspace data workbench: a per-user working area for structured data and
// scripts. One SQLite database per user (tables = datasets) plus a scoped
// file area; sandboxed agents (manager, …) reach both through these tools so
// bulk data flows disk<->disk without passing through the model context.
//
// Layout on disk (per userId, taken from MCP request _meta, never from args):
//   data/workspace/<userId>/workspace.sqlite  — the database (+ _files metadata table)
//   data/workspace/<userId>/files/            — file area, cwd for run_script
//   data/workspace/<userId>/tmp/              — transient inline-script files
//
// Tools: data_query (any SQL, capped results), run_script (python/node child
// process), ws_write_file / ws_read_file / ws_get_file / ws_list_files /
// ws_delete_file (file area with title/description metadata kept in the DB).

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ToolError, toErrorResult, toStructuredResult } from '../src/capabilities/tool-result.ts';

const WORKSPACE_ROOT = path.resolve('data', 'workspace');

// data_query result caps: the query result is the model's window into the
// data — it must stay a window, not a firehose.
const QUERY_MAX_ROWS = 200;
const QUERY_MAX_BYTES = 50_000;
const QUERY_TIMEOUT_MS = 60_000;

// run_script: the MCP call timeout is 10 minutes — the script cap stays under it.
const SCRIPT_DEFAULT_TIMEOUT_SECONDS = 60;
const SCRIPT_MIN_TIMEOUT_SECONDS = 1;
const SCRIPT_MAX_TIMEOUT_SECONDS = 540;
const SCRIPT_OUTPUT_MAX_CHARS = 20_000;

const READ_MAX_CHARS = 50_000;
const MAX_REL_PATH_LENGTH = 300;

const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ---------------------------------------------------------------------------
// Identity: the calling run's userId rides in the MCP request _meta (set by
// the tool manager for local servers) — never in model-visible arguments.
// ---------------------------------------------------------------------------

function callerUserId(extra: { _meta?: Record<string, unknown> }): string {
  const balabash = extra._meta?.balabash;
  const userId =
    balabash && typeof balabash === 'object' && !Array.isArray(balabash)
      ? (balabash as Record<string, unknown>).userId
      : undefined;

  if (typeof userId !== 'string' || !userId) {
    throw new ToolError('Workspace tools need the calling run identity, but none arrived.');
  }

  if (!USER_ID_PATTERN.test(userId)) {
    throw new ToolError(`Workspace identity "${userId}" is not usable as a directory name.`);
  }

  return userId;
}

// ---------------------------------------------------------------------------
// Workspace layout & lazy provisioning.
// ---------------------------------------------------------------------------

type Workspace = {
  filesDir: string;
  tmpDir: string;
  dbPath: string;
};

async function ensureWorkspace(userId: string): Promise<Workspace> {
  const root = path.join(WORKSPACE_ROOT, userId);
  const workspace: Workspace = {
    filesDir: path.join(root, 'files'),
    tmpDir: path.join(root, 'tmp'),
    dbPath: path.join(root, 'workspace.sqlite'),
  };

  await fs.mkdir(workspace.filesDir, { recursive: true });
  await fs.mkdir(workspace.tmpDir, { recursive: true });

  // WAL lets tool calls and run_script children read/write concurrently.
  withDb(workspace.dbPath, db => {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(
      'CREATE TABLE IF NOT EXISTS _files (' +
        'path TEXT PRIMARY KEY, title TEXT, description TEXT, updated_at TEXT NOT NULL)',
    );
  });

  return workspace;
}

// Short-lived in-process handle for the tiny metadata operations. Bulk SQL
// (data_query) runs in a child process instead — DatabaseSync is synchronous
// and must not block the single app process on a heavy query.
function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);

  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Validates a model-supplied path as relative-inside-the-file-area: no
 * absolute paths, no "..", normalized "/" separators.
 */
function sanitizeRelPath(raw: string, label = 'path'): string {
  const value = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');

  if (!value) {
    throw new ToolError(`The ${label} must be a non-empty relative path.`);
  }

  if (value.length > MAX_REL_PATH_LENGTH) {
    throw new ToolError(`The ${label} is longer than ${MAX_REL_PATH_LENGTH} characters.`);
  }

  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new ToolError(`The ${label} must be relative to the workspace file area, not absolute: "${raw}".`);
  }

  const segments = value.split('/');

  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new ToolError(`The ${label} must not contain "..", "." or empty segments: "${raw}".`);
  }

  return segments.join('/');
}

// ---------------------------------------------------------------------------
// File metadata (title/description) in the _files table of workspace.sqlite.
// Filesystem is the source of truth for existence; _files only annotates.
// ---------------------------------------------------------------------------

type FileMeta = { title: string | null; description: string | null };

function upsertMeta(dbPath: string, relPath: string, title: string | null, description: string | null): FileMeta {
  return withDb(dbPath, db => {
    db.prepare(
      "INSERT INTO _files (path, title, description, updated_at) VALUES (?, ?, ?, datetime('now')) " +
        'ON CONFLICT(path) DO UPDATE SET ' +
        'title = COALESCE(excluded.title, _files.title), ' +
        'description = COALESCE(excluded.description, _files.description), ' +
        'updated_at = excluded.updated_at',
    ).run(relPath, title, description);

    return readMeta(db, relPath);
  });
}

function readMeta(db: DatabaseSync, relPath: string): FileMeta {
  const row = db.prepare('SELECT title, description FROM _files WHERE path = ?').get(relPath) as
    | { title: string | null; description: string | null }
    | undefined;

  return { title: row?.title ?? null, description: row?.description ?? null };
}

// ---------------------------------------------------------------------------
// Child processes: both data_query and run_script execute in spawned
// processes — kill-on-timeout works and the app's event loop stays free.
// ---------------------------------------------------------------------------

// The child sees a minimal environment, not the app's secrets.
function childEnv(dbPath: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};

  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }

  return { ...env, WORKSPACE_DB: dbPath, ...extra };
}

type ChildOutcome = {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
};

function runChild(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; maxOutputChars: number },
): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    const buffers = { stdout: '', stderr: '' };
    const truncated = { stdout: false, stderr: false };

    // Keep consuming (so the pipe never backpressures the child), but stop
    // buffering past the cap.
    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (truncated[stream]) return;
      buffers[stream] += chunk.toString('utf8');
      if (buffers[stream].length > options.maxOutputChars) {
        buffers[stream] = buffers[stream].slice(0, options.maxOutputChars);
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
// data_query: any SQL against workspace.sqlite, executed in a node child.
// A row-returning statement (SELECT/RETURNING/PRAGMA) streams rows up to the
// caps; anything else runs through exec() (multi-statement scripts work) and
// reports the change count.
// ---------------------------------------------------------------------------

// Plain CommonJS source for `node -e`; the SQL arrives via argv, caps via env.
const QUERY_RUNNER = `
const { DatabaseSync } = require('node:sqlite');
const sql = process.argv[1];
const maxRows = Number(process.env.QUERY_MAX_ROWS);
const maxBytes = Number(process.env.QUERY_MAX_BYTES);
try {
  const db = new DatabaseSync(process.env.WORKSPACE_DB);
  db.exec('PRAGMA busy_timeout = 5000');
  const stmt = db.prepare(sql);
  if (stmt.columns().length > 0) {
    const rows = [];
    let bytes = 2;
    let truncated = false;
    for (const row of stmt.iterate()) {
      if (rows.length >= maxRows) { truncated = true; break; }
      const clean = {};
      for (const key of Object.keys(row)) {
        const value = row[key];
        if (value instanceof Uint8Array) clean[key] = '<blob ' + value.byteLength + ' bytes>';
        else if (typeof value === 'bigint') clean[key] = Number(value);
        else clean[key] = value;
      }
      const encoded = JSON.stringify(clean);
      if (rows.length > 0 && bytes + encoded.length > maxBytes) { truncated = true; break; }
      rows.push(clean);
      bytes += encoded.length + 1;
    }
    const out = { rows, rowCount: rows.length, truncated };
    if (truncated) out.note = 'Result truncated (caps: ' + maxRows + ' rows / ~' + maxBytes + ' bytes). Narrow with WHERE/LIMIT/OFFSET or aggregate.';
    process.stdout.write(JSON.stringify(out));
  } else {
    const before = db.prepare('SELECT total_changes() AS c').get().c;
    db.exec(sql);
    const after = db.prepare('SELECT total_changes() AS c').get().c;
    process.stdout.write(JSON.stringify({ ok: true, changes: after - before }));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ sqlError: String((error && error.message) || error) }));
  process.exitCode = 3;
}
`;

async function runQuery(workspace: Workspace, sql: string): Promise<Record<string, unknown>> {
  const outcome = await runChild(process.execPath, ['-e', QUERY_RUNNER, sql], {
    cwd: workspace.filesDir,
    env: childEnv(workspace.dbPath, {
      QUERY_MAX_ROWS: String(QUERY_MAX_ROWS),
      QUERY_MAX_BYTES: String(QUERY_MAX_BYTES),
    }),
    timeoutMs: QUERY_TIMEOUT_MS,
    // The runner emits at most ~maxBytes of rows plus envelope; leave headroom.
    maxOutputChars: QUERY_MAX_BYTES * 4,
  });

  if (outcome.timedOut) {
    throw new ToolError(`SQL query timed out after ${QUERY_TIMEOUT_MS / 1000}s and was killed.`, {
      kind: 'timeout',
    });
  }

  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(outcome.stdout) as Record<string, unknown>;
  } catch {
    throw new ToolError(
      `SQL executor failed (exit code ${outcome.exitCode}): ${outcome.stderr.slice(0, 500) || 'no output'}`,
    );
  }

  if (typeof parsed.sqlError === 'string') {
    throw new ToolError(parsed.sqlError, { kind: 'sql_error' });
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// MCP server.
// ---------------------------------------------------------------------------

function createMcpServer() {
  const server = new McpServer({ name: 'workspace', version: '1.0.0' });

  server.registerTool(
    'data_query',
    {
      description:
        'Run SQL against your persistent workspace SQLite database (shared across your sessions; tables are ' +
        'datasets). Any SQL works: CREATE TABLE, INSERT, UPDATE, DELETE, SELECT, CREATE INDEX, PRAGMA; ' +
        "multi-statement scripts are allowed for non-SELECT SQL. Inspect existing tables via SELECT name, sql FROM sqlite_master. SELECT results are capped at " +
        `${QUERY_MAX_ROWS} rows / ~${QUERY_MAX_BYTES / 1000}KB (a truncated flag is set) — query narrow slices ` +
        'or aggregates, never whole tables. For bulk loading or transforms that SQL cannot express, use run_script; ' +
        'scripts reach this same database via the WORKSPACE_DB env variable.',
      inputSchema: {
        sql: z.string().describe('The SQL to execute.'),
      },
    },
    async ({ sql }, extra) => {
      try {
        const workspace = await ensureWorkspace(callerUserId(extra));
        return toStructuredResult(await runQuery(workspace, sql));
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'run_script',
    {
      description:
        'Execute a Python or Node script on the host (stdlib only, no third-party packages). The script runs ' +
        'with the workspace file area as its working directory (relative paths = ws_* paths) and can reach ' +
        'the workspace SQLite database at the path in the WORKSPACE_DB env variable. Network access is available. ' +
        'Use scripts for everything mechanical over data: downloading with pagination, parsing, bulk transforms, ' +
        'file generation. THE IRON RULE: results belong in tables or files — print only a short summary ' +
        '(counts, sample) to stdout, never the data itself. Pass either inline code or the path of a saved ' +
        'script (save reusable scripts with ws_write_file under scripts/ and document their argv in the ' +
        'description). Large inputs go into files, not argv. Node scripts passed as inline code run as ES ' +
        `modules (use import, top-level await is fine). Stdout/stderr are capped at ${SCRIPT_OUTPUT_MAX_CHARS} chars each.`,
      inputSchema: {
        runtime: z.enum(['python', 'node']).describe('Which runtime executes the script.'),
        code: z
          .string()
          .nullable()
          .describe('Inline script source. Pass null when running a saved script via "file".'),
        file: z
          .string()
          .nullable()
          .describe(
            'Path of a saved script inside the workspace file area, e.g. "scripts/fetch.py". Pass null when using "code".',
          ),
        args: z
          .array(z.string())
          .nullable()
          .describe('Command-line arguments for the script (sys.argv / process.argv). Pass null for none.'),
        timeout_seconds: z
          .number()
          .nullable()
          .describe(
            `Timeout in seconds, ${SCRIPT_MIN_TIMEOUT_SECONDS}-${SCRIPT_MAX_TIMEOUT_SECONDS}; the script is killed when it expires. ` +
              `Pass null for the default (${SCRIPT_DEFAULT_TIMEOUT_SECONDS}).`,
          ),
      },
    },
    async ({ runtime, code, file, args, timeout_seconds }, extra) => {
      try {
        const workspace = await ensureWorkspace(callerUserId(extra));

        if ((code === null) === (file === null)) {
          throw new ToolError('Pass exactly one of "code" (inline source) or "file" (saved script path).');
        }

        const timeoutMs =
          Math.min(
            Math.max(timeout_seconds ?? SCRIPT_DEFAULT_TIMEOUT_SECONDS, SCRIPT_MIN_TIMEOUT_SECONDS),
            SCRIPT_MAX_TIMEOUT_SECONDS,
          ) * 1000;

        let scriptPath: string;
        let inlinePath: string | null = null;

        if (code !== null) {
          const extension = runtime === 'python' ? 'py' : 'mjs';
          inlinePath = path.join(
            workspace.tmpDir,
            `inline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${extension}`,
          );
          await fs.writeFile(inlinePath, code, 'utf8');
          scriptPath = inlinePath;
        } else {
          const relPath = sanitizeRelPath(file as string, 'file');
          scriptPath = path.join(workspace.filesDir, relPath);

          const stats = await fs.stat(scriptPath).catch(() => null);
          if (!stats?.isFile()) {
            throw new ToolError(`No script at "${relPath}" in the workspace file area. Check ws_list_files.`);
          }
        }

        try {
          const command = runtime === 'python' ? 'python3' : process.execPath;
          const outcome = await runChild(command, [scriptPath, ...(args ?? [])], {
            cwd: workspace.filesDir,
            env: childEnv(workspace.dbPath),
            timeoutMs,
            maxOutputChars: SCRIPT_OUTPUT_MAX_CHARS,
          });

          return toStructuredResult({
            exitCode: outcome.exitCode,
            timedOut: outcome.timedOut,
            durationMs: outcome.durationMs,
            stdout: outcome.stdout,
            stdoutTruncated: outcome.stdoutTruncated,
            stderr: outcome.stderr,
            stderrTruncated: outcome.stderrTruncated,
          });
        } finally {
          if (inlinePath) {
            await fs.unlink(inlinePath).catch(() => {});
          }
        }
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'ws_write_file',
    {
      description:
        'Create or update a file in the workspace file area (shared across your sessions). Pass content to ' +
        'write the file (parent directories are created); pass content=null to update only the title/description ' +
        'of an existing file. Omitted (null) title/description keep their previous values. Group files into ' +
        'per-task directories (e.g. "tgden/channels.csv", "scripts/fetch_tgden.py"). Always set a title and a ' +
        'description for scripts and long-lived files — listings show them, and that is how future sessions ' +
        'understand what exists; for scripts, document the accepted argv arguments in the description.',
      inputSchema: {
        path: z.string().describe('Relative path inside the workspace file area, e.g. "scripts/fetch.py".'),
        content: z.string().nullable().describe('Full file content (UTF-8). Null = keep the file, update metadata only.'),
        title: z.string().nullable().describe('Short human-readable title. Null = keep the current one.'),
        description: z
          .string()
          .nullable()
          .describe('What the file is / what the script does and its argv. Null = keep the current one.'),
      },
    },
    async ({ path: rawPath, content, title, description }, extra) => {
      try {
        const workspace = await ensureWorkspace(callerUserId(extra));
        const relPath = sanitizeRelPath(rawPath);
        const absPath = path.join(workspace.filesDir, relPath);

        if (content === null && title === null && description === null) {
          throw new ToolError('Nothing to do: content, title and description are all null.');
        }

        if (content !== null) {
          await fs.mkdir(path.dirname(absPath), { recursive: true });
          await fs.writeFile(absPath, content, 'utf8');
        } else {
          const stats = await fs.stat(absPath).catch(() => null);
          if (!stats?.isFile()) {
            throw new ToolError(`No file at "${relPath}" — to create it, pass content.`);
          }
        }

        const meta = upsertMeta(workspace.dbPath, relPath, title, description);
        const stats = await fs.stat(absPath);

        return toStructuredResult({
          path: relPath,
          sizeBytes: stats.size,
          title: meta.title,
          description: meta.description,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'ws_read_file',
    {
      description:
        `Read a text file from the workspace file area. Content is capped at ${READ_MAX_CHARS} characters ` +
        '(a truncated flag is set) — for large files, use data_query or run_script to extract the relevant part ' +
        'instead of reading everything into context.',
      inputSchema: {
        path: z.string().describe('Relative path inside the workspace file area.'),
      },
    },
    async ({ path: rawPath }, extra) => {
      try {
        const workspace = await ensureWorkspace(callerUserId(extra));
        const relPath = sanitizeRelPath(rawPath);
        const absPath = path.join(workspace.filesDir, relPath);

        const stats = await fs.stat(absPath).catch(() => null);
        if (!stats?.isFile()) {
          throw new ToolError(`No file at "${relPath}" in the workspace file area. Check ws_list_files.`);
        }

        const handle = await fs.open(absPath, 'r');
        let content: string;

        try {
          const buffer = Buffer.alloc(Math.min(stats.size, READ_MAX_CHARS * 4));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          content = buffer.subarray(0, bytesRead).toString('utf8');
        } finally {
          await handle.close();
        }

        const truncated = stats.size > Buffer.byteLength(content, 'utf8') || content.length > READ_MAX_CHARS;

        if (content.length > READ_MAX_CHARS) {
          content = content.slice(0, READ_MAX_CHARS);
        }

        return toStructuredResult({ path: relPath, sizeBytes: stats.size, content, truncated });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'ws_get_file',
    {
      description: 'Get metadata (size, modified time, title, description) of one workspace file without reading its content.',
      inputSchema: {
        path: z.string().describe('Relative path inside the workspace file area.'),
      },
    },
    async ({ path: rawPath }, extra) => {
      try {
        const workspace = await ensureWorkspace(callerUserId(extra));
        const relPath = sanitizeRelPath(rawPath);
        const absPath = path.join(workspace.filesDir, relPath);

        const stats = await fs.stat(absPath).catch(() => null);
        if (!stats?.isFile()) {
          throw new ToolError(`No file at "${relPath}" in the workspace file area. Check ws_list_files.`);
        }

        const meta = withDb(workspace.dbPath, db => readMeta(db, relPath));

        return toStructuredResult({
          path: relPath,
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          title: meta.title,
          description: meta.description,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'ws_list_files',
    {
      description:
        'List one directory of the workspace file area (non-recursive): subdirectories plus files with their ' +
        'size, title and description. Start here (path=null for the root) to see what already exists — ' +
        'especially before writing a new script.',
      inputSchema: {
        path: z.string().nullable().describe('Relative directory path, or null for the file-area root.'),
      },
    },
    async ({ path: rawPath }, extra) => {
      try {
        const workspace = await ensureWorkspace(callerUserId(extra));
        const relDir = rawPath === null ? '' : sanitizeRelPath(rawPath, 'directory path');
        const absDir = relDir ? path.join(workspace.filesDir, relDir) : workspace.filesDir;

        let entries;
        try {
          entries = await fs.readdir(absDir, { withFileTypes: true });
        } catch {
          throw new ToolError(`No directory "${relDir || '.'}" in the workspace file area.`);
        }

        const directories: string[] = [];
        const files: Array<Record<string, unknown>> = [];
        const presentNames = new Set<string>();

        const metaByPath = withDb(workspace.dbPath, db => {
          const map = new Map<string, FileMeta>();
          const rows = db.prepare('SELECT path, title, description FROM _files').all() as Array<{
            path: string;
            title: string | null;
            description: string | null;
          }>;
          for (const row of rows) {
            map.set(row.path, { title: row.title, description: row.description });
          }
          return map;
        });

        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.isDirectory()) {
            directories.push(entry.name);
            continue;
          }

          if (!entry.isFile()) continue;

          presentNames.add(entry.name);
          const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
          const stats = await fs.stat(path.join(absDir, entry.name)).catch(() => null);
          const meta = metaByPath.get(relPath);

          files.push({
            path: relPath,
            sizeBytes: stats?.size ?? null,
            modifiedAt: stats?.mtime.toISOString() ?? null,
            title: meta?.title ?? null,
            description: meta?.description ?? null,
          });
        }

        // The filesystem is the source of truth: metadata rows whose files in
        // this directory are gone (deleted by a script) are pruned on sight.
        const stale = [...metaByPath.keys()].filter(metaPath => {
          const slash = metaPath.lastIndexOf('/');
          const parent = slash === -1 ? '' : metaPath.slice(0, slash);
          const name = slash === -1 ? metaPath : metaPath.slice(slash + 1);
          return parent === relDir && !presentNames.has(name);
        });

        if (stale.length) {
          withDb(workspace.dbPath, db => {
            const remove = db.prepare('DELETE FROM _files WHERE path = ?');
            for (const metaPath of stale) remove.run(metaPath);
          });
        }

        return toStructuredResult({ path: relDir || '.', directories, files });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'ws_delete_file',
    {
      description: 'Delete one file from the workspace file area (directories cannot be deleted with this tool).',
      inputSchema: {
        path: z.string().describe('Relative path inside the workspace file area.'),
      },
    },
    async ({ path: rawPath }, extra) => {
      try {
        const workspace = await ensureWorkspace(callerUserId(extra));
        const relPath = sanitizeRelPath(rawPath);
        const absPath = path.join(workspace.filesDir, relPath);

        const stats = await fs.stat(absPath).catch(() => null);

        if (stats?.isDirectory()) {
          throw new ToolError(`"${relPath}" is a directory; this tool deletes only files.`);
        }

        const hadMeta = withDb(workspace.dbPath, db => {
          const { changes } = db.prepare('DELETE FROM _files WHERE path = ?').run(relPath);
          return Number(changes) > 0;
        });

        if (!stats && !hadMeta) {
          throw new ToolError(`No file at "${relPath}" in the workspace file area.`);
        }

        if (stats) {
          await fs.unlink(absPath);
        }

        return toStructuredResult({ path: relPath, deleted: true });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Streamable HTTP endpoint (per the local tool-server contract).
// ---------------------------------------------------------------------------

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf8');

  return body ? JSON.parse(body) : undefined;
}

export async function start(_ctx: { filesApi: unknown }) {
  const httpServer = http.createServer(async (request, response) => {
    if (request.url !== '/mcp' || request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        }),
      );
      return;
    }

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      const body = await readJsonBody(request);

      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
            id: null,
          }),
        );
      }
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();

  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    throw new Error('Local MCP server did not receive a TCP port');
  }

  return {
    config: {
      transport: 'http' as const,
      url: `http://127.0.0.1:${address.port}/mcp`,
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close(error => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}
