// One-time cleanup of the SDK sessions that accumulated before the retention
// sweep existed (src/capabilities/session-cleanup.ts): the sessions older
// than N days in the stores of Balabash's own agents — Claude transcripts in
// the CLI's project directories of `data/workspace/*/files` and
// `data/agent-state/*` (never the operator's own interactive projects), Codex
// rollouts in `data/codex-home` — minus the sessions the journal names for
// active threads. Age is the transcript's mtime: these sessions predate the
// journal's session.sdk and belong to no thread it could ask. Each goes
// through its SDK's own means (deleteClaudeSession, deleteCodexSession); a
// transcript the SDK refuses as "not found" while its file is there (an
// empty transcript) is removed with its directory directly, as is a session
// directory left without a transcript.
//
// Usage: npm run cleanup-sessions [-- --older-than <days>] [-- --apply]
//   Without --apply: a dry run — lists what would go, with sizes.
// Safe next to the live app: active threads' sessions are spared, and the
// Codex store is touched only through `codex delete`.

import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/db/client.ts';
import { claudeProjectDirName, claudeProjectsDir, deleteClaudeSession } from '../src/harness/claude-sdk/session-store.ts';
import { codexHomeDir } from '../src/harness/codex-sdk/codex-home.ts';
import { codexGeneratedImagesDir, deleteCodexSession, listCodexRollouts } from '../src/harness/codex-sdk/session-store.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const olderThanIndex = args.indexOf('--older-than');
const olderThanDays = olderThanIndex >= 0 ? Number(args[olderThanIndex + 1]) : 7;

if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
  console.error('[cleanup-sessions] --older-than needs a positive number of days');
  process.exit(2);
}

const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The sessions of threads still active: spared whatever their age.
async function activeSessionIds(): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT s.payload->>'sdkSessionId' AS id
    FROM events s JOIN threads t ON t.id = s.thread_id
    WHERE s.type = 'session.sdk' AND t.status = 'active'`;

  return new Set(rows.map(row => row.id.toLowerCase()));
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;

  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      total += await directorySize(file);
    } else if (entry.isFile()) {
      total += (await fs.stat(file)).size;
    }
  }

  return total;
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

type Candidate = { id: string; where: string; bytes: number; mtime: Date; transcript: string | null; dir: string | null };

// Balabash's own Claude project directories: the ones the SDK derives from
// the agents' cwds under data/.
async function claudeCandidates(spared: Set<string>): Promise<Candidate[]> {
  const prefixes = [claudeProjectDirName(path.resolve('data', 'workspace')) + '-', claudeProjectDirName(path.resolve('data', 'agent-state')) + '-'];
  const projects = claudeProjectsDir();
  const candidates: Candidate[] = [];
  let names: string[];

  try {
    names = await fs.readdir(projects);
  } catch {
    return [];
  }

  for (const name of names.filter(name => prefixes.some(prefix => name.startsWith(prefix))).sort()) {
    const project = path.join(projects, name);
    const entries = await fs.readdir(project, { withFileTypes: true });
    const seen = new Map<string, Candidate>();

    for (const entry of entries) {
      const file = path.join(project, entry.name);

      if (entry.isFile() && entry.name.endsWith('.jsonl') && UUID.test(entry.name.slice(0, -'.jsonl'.length))) {
        const id = entry.name.slice(0, -'.jsonl'.length).toLowerCase();
        const stat = await fs.stat(file);
        const candidate = seen.get(id) ?? { id, where: name, bytes: 0, mtime: stat.mtime, transcript: null, dir: null };

        candidate.transcript = file;
        candidate.bytes += stat.size;
        candidate.mtime = stat.mtime;
        seen.set(id, candidate);
      } else if (entry.isDirectory() && UUID.test(entry.name)) {
        const id = entry.name.toLowerCase();
        const stat = await fs.stat(file);
        const candidate = seen.get(id) ?? { id, where: name, bytes: 0, mtime: stat.mtime, transcript: null, dir: null };

        candidate.dir = file;
        candidate.bytes += await directorySize(file);
        seen.set(id, candidate);
      }
    }

    for (const candidate of seen.values()) {
      // A directory without a transcript is dated by itself; with one, by
      // the transcript (the CLI appends to it on every turn).
      if (candidate.mtime < cutoff && !spared.has(candidate.id)) {
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

async function deleteClaudeCandidate(candidate: Candidate): Promise<void> {
  let deleted = false;

  if (candidate.transcript) {
    deleted = await deleteClaudeSession(candidate.id);
  }

  if (!deleted) {
    // An empty transcript the SDK calls "not found", or a directory alone.
    if (candidate.transcript) {
      await fs.rm(candidate.transcript, { force: true });
    }
  }

  if (candidate.dir) {
    await fs.rm(candidate.dir, { recursive: true, force: true });
  }
}

type CodexCandidate = { id: string; rollouts: string[]; bytes: number; images: string | null; young: boolean };

async function codexCandidates(spared: Set<string>): Promise<CodexCandidate[]> {
  const home = codexHomeDir();
  const byId = new Map<string, CodexCandidate>();
  const candidateOf = (id: string) => byId.get(id) ?? { id, rollouts: [], bytes: 0, images: null, young: false };

  for (const rollout of await listCodexRollouts(home)) {
    const candidate = candidateOf(rollout.sdkSessionId);

    candidate.rollouts.push(rollout.file);
    candidate.bytes += rollout.size;
    // The newest rollout of the id dates the session.
    candidate.young ||= rollout.mtime >= cutoff;
    byId.set(candidate.id, candidate);
  }

  // The images directories: of the sessions above, and of sessions whose
  // rollout is gone already (dated by the directory itself).
  let imageDirs: string[] = [];

  try {
    imageDirs = await fs.readdir(path.join(home, 'generated_images'));
  } catch {
    imageDirs = [];
  }

  for (const name of imageDirs.filter(name => UUID.test(name))) {
    const id = name.toLowerCase();
    const dir = codexGeneratedImagesDir(id, home);
    const candidate = candidateOf(id);

    if (candidate.rollouts.length === 0) {
      candidate.young = (await fs.stat(dir)).mtime >= cutoff;
    }

    candidate.images = dir;
    candidate.bytes += await directorySize(dir);
    byId.set(id, candidate);
  }

  return [...byId.values()].filter(candidate => !candidate.young && !spared.has(candidate.id)).sort((a, b) => a.id.localeCompare(b.id));
}

const spared = await activeSessionIds();
const claude = await claudeCandidates(spared);
const codex = await codexCandidates(spared);
const claudeBytes = claude.reduce((sum, c) => sum + c.bytes, 0);
const codexBytes = codex.reduce((sum, c) => sum + c.bytes, 0);

console.log(`[cleanup-sessions] sessions older than ${olderThanDays} days (before ${cutoff.toISOString()}), ${spared.size} active sessions spared${apply ? '' : ' — DRY RUN'}`);

const byProject = new Map<string, { n: number; bytes: number }>();

for (const candidate of claude) {
  const entry = byProject.get(candidate.where) ?? { n: 0, bytes: 0 };

  entry.n += 1;
  entry.bytes += candidate.bytes;
  byProject.set(candidate.where, entry);
}

for (const [where, entry] of byProject) {
  console.log(`  claude  ${where}: ${entry.n} sessions, ${mb(entry.bytes)}`);
}

console.log(`  claude  total: ${claude.length} sessions, ${mb(claudeBytes)}`);
console.log(`  codex   ${codex.length} sessions (${codex.filter(c => c.images).length} with generated images), ${mb(codexBytes)}`);

if (apply) {
  let failed = 0;

  for (const candidate of claude) {
    try {
      await deleteClaudeCandidate(candidate);
    } catch (error) {
      failed += 1;
      console.error(`[cleanup-sessions] claude ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const candidate of codex) {
    try {
      await deleteCodexSession(candidate.id, codexHomeDir());
    } catch (error) {
      failed += 1;
      console.error(`[cleanup-sessions] codex ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`[cleanup-sessions] done: ${claude.length + codex.length - failed} sessions deleted, ${failed} failed, ${mb(claudeBytes + codexBytes)} freed`);
}

await prisma.$disconnect();
