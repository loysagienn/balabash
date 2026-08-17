// Workspace file-area hands: read/write/list/delete over
// data/workspace/<userId>/files plus run_script. These tools duplicate what a
// native tool preset (shell, file edits) already gives, so the server is
// granted only to agents without native hands (browser, the coordinator,
// scheduled tasks) — full-preset agents get the workspace server (data_query
// and the storage bridge) and use their own tools for files.
//
// The workspace layout and the caller-identity rules are shared with the
// workspace server — see workspace_shared.ts.

import path from 'node:path';
import fs from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolError, toErrorResult, toStructuredResult } from '../src/capabilities/tool-result.ts';
import { listDir, sanitizeRelPath, statFile, upsertMeta, withDb } from '../src/workspace/files.ts';
import { callerUserId, childEnv, ensureWorkspace, runChild, serveMcp } from './workspace_shared.ts';

// run_script: the MCP call timeout is 10 minutes — the script cap stays under it.
const SCRIPT_DEFAULT_TIMEOUT_SECONDS = 60;
const SCRIPT_MIN_TIMEOUT_SECONDS = 1;
const SCRIPT_MAX_TIMEOUT_SECONDS = 540;
const SCRIPT_OUTPUT_MAX_CHARS = 20_000;

const READ_MAX_CHARS = 50_000;

// ---------------------------------------------------------------------------
// MCP server.
// ---------------------------------------------------------------------------

function createMcpServer() {
  const server = new McpServer({ name: 'workspace_files', version: '1.0.0' });

  server.registerTool(
    'run_script',
    {
      description:
        'Execute a Python or Node script on the host (stdlib only, no third-party packages). The script runs ' +
        'with the workspace file area as its working directory (relative paths = workspace_* paths) and can reach ' +
        'the workspace SQLite database at the path in the WORKSPACE_DB env variable. Network access is available. ' +
        'Use scripts for everything mechanical over data: downloading with pagination, parsing, bulk transforms, ' +
        'file generation. THE IRON RULE: results belong in tables or files — print only a short summary ' +
        '(counts, sample) to stdout, never the data itself. Pass either inline code or the path of a saved ' +
        'script (save reusable scripts with workspace_write_file under scripts/ and document their argv in the ' +
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
            throw new ToolError(`No script at "${relPath}" in the workspace file area. Check workspace_list_files.`);
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
    'workspace_write_file',
    {
      description:
        'Create or update a text (UTF-8) file in the workspace file area (shared across your sessions; for ' +
        'binary content use workspace_import_file or run_script). Pass content to ' +
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
    'workspace_read_file',
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
          throw new ToolError(`No file at "${relPath}" in the workspace file area. Check workspace_list_files.`);
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
    'workspace_get_file',
    {
      description: 'Get metadata (size, modified time, title, description) of one workspace file without reading its content.',
      inputSchema: {
        path: z.string().describe('Relative path inside the workspace file area.'),
      },
    },
    async ({ path: rawPath }, extra) => {
      try {
        const userId = callerUserId(extra);
        await ensureWorkspace(userId);
        const relPath = sanitizeRelPath(rawPath);

        const node = await statFile(userId, relPath);
        if (!node) {
          throw new ToolError(`No file at "${relPath}" in the workspace file area. Check workspace_list_files.`);
        }

        return toStructuredResult({
          path: node.path,
          sizeBytes: node.sizeBytes,
          modifiedAt: node.modifiedAt,
          title: node.title,
          description: node.description,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'workspace_list_files',
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
        const userId = callerUserId(extra);
        await ensureWorkspace(userId);
        const relDir = rawPath === null ? '' : sanitizeRelPath(rawPath, 'directory path');

        // The core's listing (shared with the web API) also prunes orphaned
        // _files rows of this directory — the filesystem is the source of truth.
        const listing = await listDir(userId, relDir);
        if (!listing) {
          throw new ToolError(`No directory "${relDir || '.'}" in the workspace file area.`);
        }

        return toStructuredResult({
          path: relDir || '.',
          directories: listing.directories,
          // The tool's wire shape predates mediaType — kept as-is.
          files: listing.files.map(({ path: filePath, sizeBytes, modifiedAt, title, description }) => ({
            path: filePath,
            sizeBytes,
            modifiedAt,
            title,
            description,
          })),
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'workspace_delete_file',
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

export async function start(_ctx: unknown) {
  return serveMcp(createMcpServer);
}
