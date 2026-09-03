// The isolated CODEX_HOME of Balabash codex sessions: data/codex-home.
//
// The codex binary reads its whole user layer from CODEX_HOME (default
// ~/.codex): config.toml with the user's MCP servers and feature flags, the
// personal AGENTS.md (injected into every session), memories, skills, and it
// writes session rollouts and state there. A Balabash session must see none
// of the host user's personal layer — the Balabash bridge is its only MCP
// surface and its brief is its only instruction — so every session runs in a
// dedicated home the app owns. Two things are linked in from outside:
//
//   auth.json  -> ~/.codex/auth.json      the operator's ChatGPT login; codex
//                                          refreshes tokens through the link
//   skills/<x> -> plugins/balabash/skills/<x>  the repo's platform skills, the
//                                          same set the Claude 'full' preset
//                                          gets via the balabash plugin
//
// No config.toml is written: everything the session needs travels as
// --config overrides from sdk-session.ts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function codexHomeDir(): string {
  return path.resolve('data', 'codex-home');
}

function hostCodexAuthPath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

function platformSkillsDir(): string {
  return path.resolve('plugins', 'balabash', 'skills');
}

// Points `linkPath` at `target` unless a real file/directory already sits
// there (an operator may have logged in or placed a skill directly).
function ensureSymlink(linkPath: string, target: string): void {
  let existing: fs.Stats | null = null;

  try {
    existing = fs.lstatSync(linkPath);
  } catch {
    existing = null;
  }

  if (existing && !existing.isSymbolicLink()) {
    return;
  }

  if (existing) {
    if (fs.readlinkSync(linkPath) === target) {
      return;
    }

    fs.unlinkSync(linkPath);
  }

  fs.symlinkSync(target, linkPath);
}

// Idempotent; called before every session start. Returns the home path.
export function ensureCodexHome(): string {
  const home = codexHomeDir();

  fs.mkdirSync(path.join(home, 'skills'), { recursive: true });

  const hostAuth = hostCodexAuthPath();

  if (fs.existsSync(hostAuth)) {
    ensureSymlink(path.join(home, 'auth.json'), hostAuth);
  } else if (!fs.existsSync(path.join(home, 'auth.json'))) {
    console.warn(`[codex] no ${hostAuth} to link into ${home}; the session will run unauthenticated`);
  }

  const skillsDir = platformSkillsDir();

  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        ensureSymlink(path.join(home, 'skills', entry.name), path.join(skillsDir, entry.name));
      }
    }
  }

  return home;
}
