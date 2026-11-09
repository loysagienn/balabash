// The Claude CLI's own session store, as far as Balabash touches it: the
// transcripts under `<claude config dir>/projects/<encoded cwd>/` — one
// `<sessionId>.jsonl` plus a `<sessionId>/` directory of tool results and
// subagent transcripts. The SDK writes them; Balabash only deletes (the
// retention sweep, src/capabilities/session-cleanup.ts, and the one-time
// cleanup script) through the SDK's own deleteSession, never by hand.

import os from 'node:os';
import path from 'node:path';
import { deleteSession } from '@anthropic-ai/claude-agent-sdk';

// Where the CLI keeps its user layer: CLAUDE_CONFIG_DIR or ~/.claude.
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
}

export function claudeProjectsDir(): string {
  return path.join(claudeConfigDir(), 'projects');
}

// The CLI's name for the project directory of a cwd: every character outside
// [A-Za-z0-9] becomes '-' (`/home/x/app` → `-home-x-app`).
export function claudeProjectDirName(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

// Deletes the session's transcript and its directory wherever the CLI keeps
// them (every project directory is searched; the id is a UUID, unique across
// them). Resolves true when the session was found and deleted, false when no
// transcript of that id exists any more — the fact to journal either way.
// Any other failure throws.
export async function deleteClaudeSession(sdkSessionId: string): Promise<boolean> {
  try {
    await deleteSession(sdkSessionId);

    return true;
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      return false;
    }

    throw error;
  }
}
