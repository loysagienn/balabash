// Workspace data workbench, the part every agent gets: the per-user SQLite
// database (tables = datasets) and the bridge between the workspace file area
// and Balabash file storage. The file-area hands (read/write/list/delete,
// run_script) live in the separate workspace_files server — granted only to
// agents without native file tools.
//
// Layout on disk (per userId, taken from MCP request _meta, never from args):
//   data/workspace/<userId>/workspace.sqlite  — the database (+ _files metadata table)
//   data/workspace/<userId>/files/            — file area
//   data/workspace/<userId>/tmp/              — transient inline-script files
//
// Tools: data_query (any SQL, capped results), workspace_export_file (file
// area -> storage, returns a fileId) and workspace_import_file (storage ->
// file area).

import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolError, toErrorResult, toStructuredResult } from '../src/capabilities/tool-result.ts';
import type { LocalToolFilesApi } from '../src/capabilities/local-tool-source.ts';
import { guessContentType, sanitizeRelPath } from '../src/workspace/files.ts';
import { callerUserId, childEnv, ensureWorkspace, runChild, serveMcp, type Workspace } from './workspace_shared.ts';

// data_query result caps: the query result is the model's window into the
// data — it must stay a window, not a firehose.
const QUERY_MAX_ROWS = 200;
const QUERY_MAX_BYTES = 50_000;
const QUERY_TIMEOUT_MS = 60_000;

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

function createMcpServer(filesApi: LocalToolFilesApi) {
  const server = new McpServer({ name: 'workspace', version: '1.0.0' });

  server.registerTool(
    'data_query',
    {
      description:
        'Run SQL against your persistent workspace SQLite database (shared across your sessions; tables are ' +
        'datasets). Any SQL works: CREATE TABLE, INSERT, UPDATE, DELETE, SELECT, CREATE INDEX, PRAGMA; ' +
        "multi-statement scripts are allowed for non-SELECT SQL. Inspect existing tables via SELECT name, sql FROM sqlite_master. SELECT results are capped at " +
        `${QUERY_MAX_ROWS} rows / ~${QUERY_MAX_BYTES / 1000}KB (a truncated flag is set) — query narrow slices ` +
        'or aggregates, never whole tables. For bulk loading or transforms that SQL cannot express, use a ' +
        'script: it reaches this same database via the path in the WORKSPACE_DB env variable (run_script sets ' +
        'it; with native shell access, the database file lives next to the workspace file area).',
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
    'workspace_export_file',
    {
      description:
        'Upload a file from the workspace file area into Balabash file storage and return its FileRef — the ' +
        'id is a fileId, the address every storage-side consumer understands (send_file, end_thread fileIds, ' +
        'message attachments, storage_get_file). This is the way a file produced in the workspace reaches ' +
        'the user. Binary-safe: the content is streamed server-side, never through the model context.',
      inputSchema: {
        path: z.string().describe('Relative path of the file inside the workspace file area.'),
        filename: z
          .string()
          .nullable()
          .describe('Filename the stored file (and the user) will see. Null = the last segment of path.'),
        content_type: z
          .string()
          .nullable()
          .describe('MIME type of the file. Null = guessed from the file extension.'),
      },
    },
    async ({ path: rawPath, filename, content_type }, extra) => {
      try {
        const userId = callerUserId(extra);
        const workspace = await ensureWorkspace(userId);
        const relPath = sanitizeRelPath(rawPath);
        const absPath = path.join(workspace.filesDir, relPath);

        const stats = await fs.stat(absPath).catch(() => null);
        if (!stats?.isFile()) {
          throw new ToolError(`No file at "${relPath}" in the workspace file area.`);
        }

        const originalFilename = filename?.trim() || relPath.split('/').pop() || relPath;
        const contentType = content_type?.trim() || guessContentType(originalFilename);

        const stored = await filesApi.ingest({
          body: createReadStream(absPath),
          userId,
          originalFilename,
          contentType,
          sizeBytes: stats.size,
          scope: 'workspace',
        });

        // The one FileRef, verbatim from the files layer.
        return toStructuredResult(stored);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'workspace_import_file',
    {
      description:
        'Download a stored Balabash file (by fileId) into the workspace file area, so scripts and ' +
        'workspace-side tools can work with its content. The reverse of workspace_export_file, and the way ' +
        'to bring binary content into the workspace. The content is streamed server-side, never through the ' +
        'model context.',
      inputSchema: {
        fileId: z.string().describe('The Balabash fileId to import (from an event or a tool result).'),
        path: z
          .string()
          .nullable()
          .describe(
            'Destination relative path inside the workspace file area (an existing file is overwritten). ' +
              'Null = "imports/<original filename>".',
          ),
      },
    },
    async ({ fileId: rawFileId, path: rawPath }, extra) => {
      try {
        const userId = callerUserId(extra);
        const workspace = await ensureWorkspace(userId);
        const fileId = rawFileId.trim();

        if (!fileId) {
          throw new ToolError('workspace_import_file requires fileId.');
        }

        // Workspace boundary: a foreign file reads as missing, same as an
        // unknown id — existence outside the workspace is not leaked.
        const file = await filesApi.get(fileId).catch(() => null);
        if (!file || file.userId !== userId) {
          throw new ToolError(`File "${fileId}" not found.`);
        }

        const relPath = rawPath !== null ? sanitizeRelPath(rawPath) : defaultImportPath(fileId, file.originalFilename);
        const absPath = path.join(workspace.filesDir, relPath);

        const content = await filesApi.open(fileId);

        await fs.mkdir(path.dirname(absPath), { recursive: true });
        await pipeline(Readable.fromWeb(content as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(absPath));

        const stats = await fs.stat(absPath);

        return toStructuredResult({
          path: relPath,
          sizeBytes: stats.size,
          contentType: file.contentType,
          fileId,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Bridge helpers: destination naming for imports (content-type guessing comes
// from the file-area core).
// ---------------------------------------------------------------------------

// "imports/<original filename>" when the stored name survives path
// sanitization; the fileId otherwise.
function defaultImportPath(fileId: string, originalFilename: string | null): string {
  const basename = originalFilename?.split(/[/\\]/).pop()?.trim();

  if (basename) {
    try {
      return sanitizeRelPath(`imports/${basename}`);
    } catch {
      // Fall through to the fileId-based name.
    }
  }

  return `imports/${fileId}`;
}

export async function start(ctx: { filesApi: LocalToolFilesApi }) {
  return serveMcp(() => createMcpServer(ctx.filesApi));
}
