// Shared plumbing of the two workspace tool servers (workspace.ts and
// workspace_files.ts): caller identity, lazy workspace provisioning, the
// streamable HTTP endpoint scaffolding, and the re-exported child execution
// machinery (owned by src/workspace/child.ts). Not a tool server itself —
// deliberately not listed in tools/index.ts.

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ToolError } from '../src/capabilities/tool-result.ts';
import { ensureFilesDb } from '../src/workspace/files.ts';
import { workspaceRoot } from '../src/workspace/layout.ts';

// Child execution moved to the workspace core (src/workspace/child.ts) so the
// apps data gateway reuses the same machinery; re-exported here because the
// tool servers reach shared plumbing through this module.
export { childEnv, runChild, type ChildOutcome } from '../src/workspace/child.ts';

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
