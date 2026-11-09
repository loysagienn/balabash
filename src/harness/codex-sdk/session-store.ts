// The Codex CLI's own session store, as far as Balabash touches it: the
// rollouts under `CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-<stamp>-<id>.jsonl`
// with their rows in the CLI's sqlite files, and `generated_images/<id>/` of
// the image sessions. The CLI writes them; Balabash only deletes (the
// retention sweep, src/capabilities/session-cleanup.ts, and the one-time
// cleanup script) through the CLI's own `codex delete --force <id>` — the
// rollout and its sqlite rows go together — plus the images directory the
// command leaves behind.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { codexBinary } from './codex-binary.ts';
import { codexHomeDir } from './codex-home.ts';
import { mergeEnv } from '../env.ts';

const execFileAsync = promisify(execFile);

export type CodexRollout = { sdkSessionId: string; file: string; size: number; mtime: Date };

// Every rollout under CODEX_HOME/sessions, newest directories last; the id is
// the UUID the file name ends with.
export async function listCodexRollouts(home: string = codexHomeDir()): Promise<CodexRollout[]> {
  const root = path.join(home, 'sessions');
  const rollouts: CodexRollout[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;

    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(file);
      } else if (entry.isFile()) {
        const match = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(entry.name);

        if (match) {
          const stat = await fs.stat(file);

          rollouts.push({ sdkSessionId: match[1]!.toLowerCase(), file, size: stat.size, mtime: stat.mtime });
        }
      }
    }
  }

  await walk(root);

  return rollouts;
}

export function codexGeneratedImagesDir(sdkSessionId: string, home: string = codexHomeDir()): string {
  return path.join(home, 'generated_images', sdkSessionId);
}

// `codex delete --force <id>` in the app's CODEX_HOME, with the vendored
// binary of the sessions. The CLI answers every failure with the same line,
// so the rollout is looked up first: none — the session is already gone
// (false); one — the command must succeed (true), else it throws.
export async function deleteCodexSession(sdkSessionId: string, home: string = codexHomeDir()): Promise<boolean> {
  const rollouts = (await listCodexRollouts(home)).filter(rollout => rollout.sdkSessionId === sdkSessionId.toLowerCase());
  let found = false;

  if (rollouts.length > 0) {
    const binary = codexBinary();
    const env = mergeEnv({ CODEX_HOME: home });

    env.PATH = [...binary.pathDirs, env.PATH ?? ''].filter(Boolean).join(path.delimiter);

    try {
      await execFileAsync(binary.executablePath, ['delete', '--force', sdkSessionId], { env, timeout: 60_000 });
    } catch (error) {
      const stderr = typeof (error as { stderr?: unknown }).stderr === 'string' ? (error as { stderr: string }).stderr.trim() : '';

      throw new Error(`codex delete --force ${sdkSessionId} failed${stderr ? `: ${stderr}` : ''}`, { cause: error });
    }

    found = true;
  }

  await fs.rm(codexGeneratedImagesDir(sdkSessionId, home), { recursive: true, force: true });

  return found;
}
