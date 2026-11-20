// The node `workspace`: the workbench of the workspace — its SQLite
// database, shell commands in its file area, the file area for agents
// without a disk (workspace-files.ts) and the mini-apps (workspace-apps.ts).
// Both actions here run in a child process of the workspace layer
// (src/workspace/child.ts): a heavy query or a hung command never holds the
// app, and a limit of time kills the process.

import fs from 'node:fs/promises';
import { z } from 'zod';
import { CapabilityError, WorkspacePath, capability, node, type JsonObject } from '../catalog/index.ts';
import { ProcessGroupCleanupError } from '../runtime/process-groups.ts';
import { childEnv, runChild, sqlInChild, type ChildOutcome } from '../workspace/child.ts';
import { absolutePath, areaPath, provideWorkbench } from './file-area.ts';
import { workspaceApps } from './workspace-apps.ts';
import { workspaceFiles } from './workspace-files.ts';

// The caps of a query result, named in the description: the result is a
// window into the data.
const QUERY_MAX_ROWS = 200;
const QUERY_MAX_BYTES = 50_000;
const QUERY_TIMEOUT_MS = 60_000;

const cell = z.union([z.string(), z.number(), z.null(), z.strictObject({ blobSizeBytes: z.int() })]);

const queryOutput = z.strictObject({
  rows: z
    .array(z.record(z.string(), cell))
    .nullable()
    .describe('null for a statement that returns no rows. A blob value comes as its size.'),
  truncated: z.boolean().describe('true: the rows were cut at the cap.'),
  changes: z.int().nullable().describe('Rows inserted, updated or deleted; null for a row-returning statement.'),
});

const query = capability({
  name: 'query',
  summary: 'Run SQL against the workspace SQLite database',
  description:
    'Run SQL against the persistent SQLite database of the workspace, shared by all its sessions. A row-returning statement gives `rows`, capped at 200 rows and about 50 KB; anything else gives `changes`. Several statements in one call are allowed when none returns rows. The query is killed after 60 seconds.',
  input: z.strictObject({ sql: z.string() }),
  output: queryOutput,
  async run({ sql }, { caller }) {
    const { filesDir, dbPath } = await provideWorkbench(caller.workspaceId);
    const outcome = await sqlInChild(dbPath, filesDir, sql, {
      maxRows: QUERY_MAX_ROWS,
      maxBytes: QUERY_MAX_BYTES,
      timeoutMs: QUERY_TIMEOUT_MS,
    });

    switch (outcome.status) {
      case 'ok':
        // The child answers in the form of the output; the check of the
        // value on the way out holds it to that.
        return outcome.result as z.input<typeof queryOutput>;
      case 'timeout':
        throw new CapabilityError(
          'invalid_input',
          `The query ran longer than ${QUERY_TIMEOUT_MS / 1000} seconds and was killed: narrow it, or do the heavy work in a command.`,
        );
      case 'sql_error':
        throw new CapabilityError(outcome.locked ? 'conflict' : 'invalid_input', outcome.message);
      case 'failed':
        throw new Error(
          `The SQL child failed (exit code ${outcome.exitCode}): ${outcome.stderr.slice(0, 500) || 'no output'}`,
        );
    }
  },
});

// ---------------------------------------------------------------------------
// run_command

const COMMAND_OUTPUT_MAX_CHARS = 20_000;

// The commands in flight, each with the handle that kills it — from the
// moment the call is taken, before its process exists: a command is a
// process group of its own and would outlive the app, so the shutdown of
// the app stops them all, and a restart waits while one runs. Killing is
// done by the time killRunningCommands returns: a group that runs has got
// its signal, and a call still on its way to a process starts none.
const runningCommands = new Set<AbortController>();

export function countRunningCommands(): number {
  return runningCommands.size;
}

export function killRunningCommands(): void {
  for (const command of runningCommands) {
    command.abort();
  }
}

// What a failed command leaves for the caller: a program that can live with
// the failure reads it from the error.
function failureDetails(outcome: Pick<ChildOutcome, 'exitCode' | 'timedOut' | 'stdout' | 'stdoutTruncated' | 'stderr' | 'stderrTruncated'>): JsonObject {
  return {
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    stdout: outcome.stdout,
    stdoutTruncated: outcome.stdoutTruncated,
    stderr: outcome.stderr,
    stderrTruncated: outcome.stderrTruncated,
  };
}

const NOT_STARTED = { exitCode: null, timedOut: false, stdout: '', stdoutTruncated: false, stderr: '', stderrTruncated: false };

const runCommand = capability({
  name: 'run_command',
  summary: 'Run a shell command in the workspace file area',
  description:
    'Run a shell command with bash on the host, in the workspace file area, with the network available. Environment: PATH, HOME, locale, TZ, WORKSPACE_DB. Exit code 0 gives the output. Any other exit code, or a timeout, is an error whose details carry the exit code and the output. A background process it leaves is killed when it ends. Output is capped at 20 000 characters per stream, the end kept.',
  input: z.strictObject({
    command: z.string(),
    cwd: WorkspacePath.describe('Default: the root of the file area.').optional(),
    timeoutSeconds: z.int().min(1).max(18000).default(60).describe('The command is killed when it expires.'),
  }),
  output: z.strictObject({
    stdout: z.string(),
    stdoutTruncated: z.boolean().describe('true: stdout was longer than the kept end.'),
    stderr: z.string(),
    stderrTruncated: z.boolean(),
    durationMs: z.int(),
  }),
  async run(input, { caller, signal, program }) {
    // Killed by whoever cancels the call, by the end of the program that
    // started it (a program out of time takes its command with it) and by
    // the shutdown of the app.
    const running = new AbortController();
    const cancelled = AbortSignal.any([running.signal, ...(signal ? [signal] : []), ...(program ? [program.ended] : [])]);

    runningCommands.add(running);

    try {
      return await runInArea(input, caller.workspaceId, cancelled, program?.ended ?? null);
    } finally {
      runningCommands.delete(running);
    }
  },
});

type CommandInput = { command: string; cwd?: string | undefined; timeoutSeconds: number };
type CommandOutput = { stdout: string; stdoutTruncated: boolean; stderr: string; stderrTruncated: boolean; durationMs: number };

async function runInArea(
  input: CommandInput,
  workspaceId: string,
  cancelled: AbortSignal,
  programEnded: AbortSignal | null,
): Promise<CommandOutput> {
  const relCwd = input.cwd === undefined ? null : areaPath(input.cwd, 'cwd');
  const { filesDir, dbPath } = await provideWorkbench(workspaceId);
  const cwd = relCwd === null ? filesDir : absolutePath(workspaceId, relCwd);

  if (relCwd !== null && !(await fs.stat(cwd).catch(() => null))?.isDirectory()) {
    throw new CapabilityError('not_found', `There is no directory at "${relCwd}" in the workspace file area.`);
  }

  // A call cancelled on its way here starts nothing.
  if (cancelled.aborted) {
    throw new CapabilityError('external_error', 'The command was not started: the call was cancelled.', NOT_STARTED);
  }

  let outcome: ChildOutcome;

  try {
    outcome = await runChild('bash', ['-c', input.command], {
      cwd,
      env: childEnv(dbPath),
      timeoutMs: input.timeoutSeconds * 1000,
      maxOutputChars: COMMAND_OUTPUT_MAX_CHARS,
      capMode: 'tail',
      signal: cancelled,
      // The command is over when the call is: nothing it started stays
      // behind in its group, out of reach of the time limit and of the
      // shutdown.
      ownsGroup: true,
      wholeCharacters: true,
    });
  } catch (error) {
    if (error instanceof ProcessGroupCleanupError) throw error;
    throw new CapabilityError(
      'external_error',
      `The command could not be started: ${error instanceof Error ? error.message : String(error)}`,
      NOT_STARTED,
    );
  }

  // Why the command ended is its own fact, apart from the exit code of the
  // shell: a shell that had exited with 0 while something it started still
  // held the output, and was then killed with it, did not succeed.
  const killed = outcome.timedOut || cancelled.aborted;

  if (outcome.exitCode === 0 && !killed) {
    return {
      stdout: outcome.stdout,
      stdoutTruncated: outcome.stdoutTruncated,
      stderr: outcome.stderr,
      stderrTruncated: outcome.stderrTruncated,
      durationMs: outcome.durationMs,
    };
  }

  const what = outcome.timedOut
    ? `The command ran longer than ${input.timeoutSeconds} seconds and was killed`
    : programEnded?.aborted
      ? 'The command was killed with the program that started it'
      : cancelled.aborted
        ? 'The command was killed: the call was cancelled'
        : outcome.exitCode === null
          ? 'The command was killed by a signal'
          : `The command exited with code ${outcome.exitCode}`;

  throw new CapabilityError(
    'external_error',
    `${what}. Its output is in the details of this error.`,
    failureDetails(killed ? { ...outcome, exitCode: null } : outcome),
  );
}

export const workspace = node({
  name: 'workspace',
  summary:
    "The workspace's workbench: a persistent SQLite database, shell commands, the file area for agents without a disk, and mini-apps. Come here to keep, query and transform the user's data.",
  guide: [
    {
      text: 'Data lives in tables, not in your context: load it into the database once, then read narrow slices or aggregates with `workspace_query`. Inspect the schema of the database before querying unfamiliar tables.',
    },
    {
      text: 'A command run in the workspace reaches the same database at the path in the WORKSPACE_DB environment variable.',
    },
    {
      text: 'An agent with a shell of its own works in that shell. `workspace_run_command` is the hands of a program, of a scheduled task and of an agent without a shell.',
    },
  ],
  children: [query, runCommand, workspaceFiles, workspaceApps],
});
