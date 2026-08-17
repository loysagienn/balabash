// Shared plumbing of the two workspace tool servers (workspace.ts and
// workspace_files.ts): caller identity, lazy workspace provisioning, child
// process execution and the streamable HTTP endpoint scaffolding. Not a tool
// server itself — deliberately not listed in tools/index.ts.

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ToolError } from '../src/capabilities/tool-result.ts';
import { ensureFilesDb } from '../src/workspace/files.ts';
import { workspaceRoot } from '../src/workspace/layout.ts';

const WORKSPACE_ROOT = workspaceRoot();

const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ---------------------------------------------------------------------------
// Identity: the calling run's userId rides in the MCP request _meta (set by
// the tool manager for local servers) — never in model-visible arguments.
// ---------------------------------------------------------------------------

export function callerUserId(extra: { _meta?: Record<string, unknown> }): string {
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

export type Workspace = {
  filesDir: string;
  tmpDir: string;
  dbPath: string;
};

export async function ensureWorkspace(userId: string): Promise<Workspace> {
  const root = path.join(WORKSPACE_ROOT, userId);
  const workspace: Workspace = {
    filesDir: path.join(root, 'files'),
    tmpDir: path.join(root, 'tmp'),
    dbPath: path.join(root, 'workspace.sqlite'),
  };

  await fs.mkdir(workspace.filesDir, { recursive: true });
  await fs.mkdir(workspace.tmpDir, { recursive: true });

  ensureFilesDb(workspace.dbPath);

  return workspace;
}

// ---------------------------------------------------------------------------
// Child processes: data_query and run_script execute in spawned processes —
// kill-on-timeout works and the app's event loop stays free.
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

export function runChild(
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
// Streamable HTTP endpoint (per the local tool-server contract): a stateless
// per-request MCP server on loopback, returning { config, close }.
// ---------------------------------------------------------------------------

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf8');

  return body ? JSON.parse(body) : undefined;
}

export async function serveMcp(createMcpServer: () => McpServer) {
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
