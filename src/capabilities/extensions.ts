// Extensions: code and configs that are part of the installation or of a
// workspace rather than of the repository — loaded from `data/` (gitignored)
// at runtime by dynamic import, next to the repository catalogs that ship
// inside the bundle. Node runs .ts files natively (type stripping), and an
// import() of a path computed at runtime is left alone by esbuild, so an
// extension needs no build: a tool or a server config is picked up at the
// next boot, a task body at its next fire.
//
//   data/tools/<name>.ts                      in-process tool server, export start(ctx)
//   data/mcp-servers/<name>.json              external MCP server config
//   data/workspace/<userId>/tasks/<slug>.ts   scheduled task body, export run(ctx)
//
// Tools and server configs are installation-wide (shared by every workspace,
// like the repository's tools/ and mcp-servers/); a task is a workspace
// notion and lives with the workspace. Names never shadow the repository's:
// a clash is a loud error. The contract of an extension module is the same
// as its repository twin's, with one rule: no runtime imports from the
// repository tree — packages from node_modules and `import type` only;
// everything else arrives through ctx (a second copy of a bundled module
// would be a different module instance). Extensions run inside the app
// process with the same trust as bundled code.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const INSTALLATION_TOOLS_DIR = path.resolve('data', 'tools');
export const INSTALLATION_SERVERS_DIR = path.resolve('data', 'mcp-servers');

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
 * in memory until the process ends — negligible for task-sized modules).
 */
export async function importExtensionModule(file: string): Promise<Record<string, unknown>> {
  const stats = await stat(file);
  const url = `${pathToFileURL(file).href}?v=${Math.round(stats.mtimeMs)}`;

  return (await import(url)) as Record<string, unknown>;
}
