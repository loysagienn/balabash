// Installation extensions shared by all workspaces: MCP connection settings
// in data/mcp-servers and remote agent drivers in data/remote-agents.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const INSTALLATION_SERVERS_DIR = path.resolve('data', 'mcp-servers');
export const INSTALLATION_REMOTE_AGENTS_DIR = path.resolve('data', 'remote-agents');

export function isMissingDirectoryError(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT';
}

/** Regular files of a directory with the extension, sorted; [] when the directory is absent. */
export async function listExtensionFiles(directory: string, extension: string): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return [];
    }

    throw error;
  }

  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(extension))
    .map(entry => entry.name)
    .sort();
}

/**
 * Imports an extension module fresh: the file's mtime rides in the URL, so
 * an edited file is a new module to the loader (the previous version stays
 * in memory until the process ends).
 */
export async function importExtensionModule(file: string): Promise<Record<string, unknown>> {
  const stats = await stat(file);
  const url = `${pathToFileURL(file).href}?v=${Math.round(stats.mtimeMs)}`;

  return (await import(url)) as Record<string, unknown>;
}
