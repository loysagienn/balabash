// In-process tool servers (§10): tools/*.ts files export start(ctx) which
// brings up a streamable HTTP MCP endpoint on loopback and returns { config,
// close }. The modules ship inside the app bundle through the static
// tools/index.ts — the import() machinery went away with hot-reload — but
// each module is still validated hard before it is trusted.

import type { FileRef } from '../core/contract.ts';
import type { StorageBody } from '../files/storage.ts';
import { validateExternalServerConfig, type ExternalServerConfig } from './server-config.ts';

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
};

export type LocalToolContext = {
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
