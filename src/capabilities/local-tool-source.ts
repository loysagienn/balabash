// In-process tool servers (§10): tools/*.ts files export start(ctx) which
// brings up a streamable HTTP MCP endpoint on loopback and returns { config,
// close }. Repository modules ship inside the app bundle through the static
// tools/index.ts; installation extensions are imported at boot from
// data/tools/<name>.ts (extensions.ts) under the same contract — each module
// is validated hard before it is trusted.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FileRef } from '../core/contract.ts';
import type { StorageBody } from '../files/storage.ts';
import { validateExternalServerConfig, type ExternalServerConfig } from './server-config.ts';
import type { StructuredToolResult, ToolError } from './tool-result.ts';

export type LocalToolSource = {
  config: ExternalServerConfig;
  close: () => Promise<void>;
};

// The files surface handed to a local tool (tools/AGENTS.md): stored files by
// opaque fileId plus ingest for new ones. The API itself is global — a local
// tool serves every workspace — so ingest takes the calling run's userId,
// which every call receives in the MCP request _meta (extra._meta.balabash):
// a file stored without it is ownerless and undeliverable to the user.
export type LocalToolFilesApi = {
  ingest: (input: {
    body: StorageBody;
    userId?: string | null;
    originalFilename?: string | null;
    contentType?: string | null;
    sizeBytes?: number | null;
    scope?: string | null;
    width?: number | null;
    height?: number | null;
  }) => Promise<FileRef>;
  get: (fileId: string) => Promise<FileRef>;
  getDownloadUrl: (
    fileId: string,
    options?: { expiresInSeconds?: number },
  ) => Promise<{ url: string; expiresAt: Date }>;
  // The stored content as a stream — for tools that move a file server-side
  // (e.g. workspace_import_file) without a presigned-URL roundtrip.
  open: (fileId: string) => Promise<ReadableStream<Uint8Array>>;
};

// The helpers a repository tool imports from tools/workspace_shared.ts and
// tool-result.ts, handed to extension modules through ctx — an extension
// must not import runtime code from the repository tree (extensions.ts).
export type LocalToolHelpers = {
  // Serves a streamable HTTP MCP endpoint on loopback; one server instance
  // per request. Returns what start() must return.
  serveMcp: (createMcpServer: () => McpServer) => Promise<{ config: ExternalServerConfig; close: () => Promise<void> }>;
  // The calling run's userId from the request _meta (per-user scoping).
  callerUserId: (extra: { _meta?: Record<string, unknown> }) => string;
  toStructuredResult: (data: unknown) => StructuredToolResult;
  toErrorResult: (error: unknown) => StructuredToolResult;
  ToolError: typeof ToolError;
};

export type LocalToolContext = LocalToolHelpers & {
  filesApi: LocalToolFilesApi;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function startLocalToolSource(
  serverName: string,
  module: Record<string, unknown>,
  ctx: LocalToolContext,
): Promise<LocalToolSource> {
  const filename = `${serverName}.ts`;
  const exports = Object.keys(module);

  if (exports.length !== 1 || exports[0] !== 'start') {
    throw new Error(`${filename} must export only "start"`);
  }

  if (typeof module.start !== 'function') {
    throw new Error(`${filename} export "start" must be a function`);
  }

  const result = (await module.start(ctx)) as unknown;

  if (!isObject(result) || !('config' in result) || typeof result.close !== 'function') {
    throw new Error(`${filename} start() must return { config, close }`);
  }

  return {
    config: validateExternalServerConfig(result.config, `${filename} start() result`),
    close: result.close as () => Promise<void>,
  };
}
