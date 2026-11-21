import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '../../prisma-generated/client.ts';
import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import { programSyntaxProblem } from '../../src/catalog/index.ts';
import { formerRunData } from '../../src/schedule/journal.ts';
import { PROGRAM_TIMEOUT_DEFAULT_MS } from '../../src/schedule/programs.ts';
import { gmailNewMail } from './gmail-new-mail.ts';

type Tx = Prisma.TransactionClient;

export async function moveJobRuns(tx: Tx) {
  let moved = 0;
  while (true) {
    const jobs = await tx.jobRun.findMany({ take: 200, orderBy: { id: 'asc' } });
    if (!jobs.length) return moved;
    const rows = jobs.map(job => {
      const { error, value, ...fields } = formerRunData(job);
      return { ...fields, ...(error === null ? {} : { error }) };
    });
    // A collision is an error. Never discard a source row on conflict.
    await tx.scheduleRun.createMany({ data: rows });
    await tx.jobRun.deleteMany({ where: { id: { in: jobs.map(job => job.id) } } });
    moved += rows.length;
  }
}

function commandProgram(task: ScheduledTaskModel, timeoutMs: number) {
  if (!task.command) throw new Error('Missing command for ' + task.slug);
  const args = {
    command: task.command,
    ...(task.cwd ? { cwd: task.cwd } : {}),
    timeoutSeconds: Math.ceil(timeoutMs / 1000),
  };
  return [
    "const result = await call('workspace_run_command', " + JSON.stringify(args) + ');',
    'if (result.stdout) console.log(result.stdout);',
    'if (result.stderr) console.error(result.stderr);',
    task.reportOnSuccess ? 'return { output: result.stdout.slice(-1000) };' : 'return null;',
  ].join('\n');
}

// These five actual dispatches, addressed by their original event ids and
// times, provide exactly the memory the former program saw on its next run.
async function seedGmail(tx: Tx, task: ScheduledTaskModel) {
  return tx.$executeRaw`
    INSERT INTO schedule_runs (id, workspace_id, slug, trigger, code, status, started_at, finished_at, value, has_value)
    SELECT id, workspace_id, ${task.slug}, ${task.cron ? 'cron' : task.at ? 'at' : 'manual'},
      '// Historical gmail-new-mail notification from the TaskContext module.', 'ok', created_at, created_at,
      payload - 'name' - 'slug', true FROM events
    WHERE workspace_id = ${task.workspaceId} AND type = 'schedule.fired' AND payload->>'slug' = ${task.slug}
      AND NOT (payload ? 'runId')
    ORDER BY seq DESC LIMIT 5`;
}

async function optionalSource(file: string) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function replacement(task: ScheduledTaskModel, workspaces: string, programs?: string) {
  // An installation may have different code under the same slug.
  if (programs) {
    const program = await optionalSource(path.join(programs, task.workspaceId, task.slug + '.js'));
    if (program) return program.toString('utf8');
  }
  if (task.slug === 'gmail-new-mail') {
    const source = await optionalSource(path.join(workspaces, task.workspaceId, 'tasks', task.slug + '.ts'));
    if (
      source && createHash('sha256').update(source).digest('hex') ===
      '16fcbd40b77222d33516ab70dd684412e9789359c9ba0ebb009aab1f5bc39d27'
    ) {
      return gmailNewMail;
    }
  }
  throw new Error(
    'Supply the translated program with --programs DIR: ' + path.join(task.workspaceId, task.slug + '.js'),
  );
}

export async function migrateTasks(tx: Tx, workspaces: string, programs?: string) {
  const tasks = await tx.scheduledTask.findMany({ where: { kind: { notIn: ['note', 'program'] } } });
  let seeds = 0;
  for (const task of tasks) {
    if (!['command', 'code'].includes(task.kind))
      throw new Error('Unknown task kind ' + task.kind + ' of ' + task.slug);
    const timeoutMs = task.timeoutMs ?? PROGRAM_TIMEOUT_DEFAULT_MS;
    const code =
      task.kind === 'command' ? commandProgram(task, timeoutMs) : await replacement(task, workspaces, programs);
    const problem = programSyntaxProblem(code);
    if (!code.trim() || problem)
      throw new Error('Invalid program for ' + task.slug + ': ' + (problem?.text ?? 'empty body'));
    if (task.slug === 'gmail-new-mail' && code === gmailNewMail) seeds += await seedGmail(tx, task);
    await tx.scheduledTask.update({
      where: { id: task.id },
      data: {
        kind: 'program',
        code,
        timeoutMs,
        command: null,
        cwd: null,
        reportOnSuccess: false,
      },
    });
  }
  return { tasks: tasks.length, seeds };
}
