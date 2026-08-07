// In-process tool servers (§10): tools/*.ts files export start(ctx) which
// brings up a streamable HTTP MCP endpoint on loopback and returns { config,
// close }. The files live on the dynamic side of the bundle boundary (§7.1):
// they are native import()s that must not import runtime values from src/ —
// core behaviour reaches them through ctx.

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FileDescriptor } from '../files/index.ts';
import type { StorageBody } from '../files/storage.ts';
import { validateExternalServerConfig, type ExternalServerConfig } from './server-config.ts';

export type LocalToolSource = {
  config: ExternalServerConfig;
  close: () => Promise<void>;
};

// The files surface handed to a local tool (tools/AGENTS.md): stored files by
// opaque fileId plus ingest for new ones. Global, not workspace-scoped — a
// local tool serves every workspace; scoping happens at the calling run.
export type LocalToolFilesApi = {
  ingest: (input: {
    body: StorageBody;
    originalFilename?: string | null;
    contentType?: string | null;
    sizeBytes?: number | null;
    scope?: string | null;
    width?: number | null;
    height?: number | null;
  }) => Promise<FileDescriptor>;
  get: (fileId: string) => Promise<FileDescriptor>;
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

export async function startLocalToolSource(filepath: string, ctx: LocalToolContext): Promise<LocalToolSource> {
  const fileStat = await stat(filepath);
  const moduleUrl = pathToFileURL(filepath);

  moduleUrl.searchParams.set('v', String(fileStat.mtimeMs));

  const module = (await import(moduleUrl.href)) as Record<string, unknown>;
  const filename = path.basename(filepath);
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
