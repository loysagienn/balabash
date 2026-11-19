// The runner of programs. A program is JavaScript that has only the catalog:
// it calls capabilities by name and returns one value. There is one runner
// for both launches — the action `run_program` runs the text of a call on
// the spot, a scheduled task runs the same text at its trigger; what differs
// between them (whose grant, how long, who gets the value) is the launcher's
// to say, not the runner's.
//
// - Every run is a process of its own (program-process.ts): hung or heavy
//   code never holds the app, and the limit of time kills the process.
// - A call of the program comes to the app and takes the one path of a call
//   (invoke.ts) under the grant of the run, carrying the id of the run.
// - When the run is over — returned, failed, out of time or stopped — its
//   scope says so (`ProgramScope.ended`): a command the program started is
//   killed with it. Any other call that had started goes on to its own end;
//   a call that had not started yet starts no more.
// - A launcher that cancels the run (`ProgramEnv.signal`) cancels its calls
//   with it: each call in flight gets the same signal a cancelled direct
//   call gets.
// - The output of `console` stays with the run and is not given to the one
//   who launched it.
//
// A run gives the content of its record whole (ProgramRun); where the record
// is kept is the launcher's.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { ACTIONS } from './actions.ts';
import type { ProgramScope } from './definition.ts';
import { describe } from './describe.ts';
import { CapabilityError, ERROR_KINDS, toCapabilityError, type CapabilityErrorValue, type ErrorKind } from './errors.ts';
import type { ConnectionsPort, Grant } from './grant.ts';
import { parseActionInput } from './input.ts';
import { invokeCapability } from './invoke.ts';
import type { JsonValue } from './json.ts';
import { PROGRAM_PROCESS } from './program-process.ts';

// How many calls of one run are carried out at a time; the rest wait their
// turn in the order they were made. A program may start any number at once
// (a Promise.all over a list), and each call in flight holds its own
// resources in the app.
const MAX_CALLS_IN_FLIGHT = 8;

// The end of the console output kept with a run.
const CONSOLE_TAIL_CHARS = 20_000;

// The heap of a program's process: code that eats memory dies alone.
const PROGRAM_HEAP_MB = 512;

// What the standard error of a process that died is cut to in the error.
const STDERR_TAIL_CHARS = 2_000;

export type ProgramOutcome = 'ok' | 'failed' | 'timeout' | 'aborted';

// One run of a program: the content of its record.
export type ProgramRun = {
  id: string;
  code: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  outcome: ProgramOutcome;
  // What the program returned; null when the outcome is not `ok` (and when
  // it returned null).
  value: JsonValue | null;
  // Why the run did not end well; null when the outcome is `ok`.
  error: CapabilityErrorValue | null;
  // The end of what the program wrote to `console`.
  console: string;
  consoleTruncated: boolean;
};

export type ProgramEnv = {
  connections: ConnectionsPort;
  // Aborting it stops the run: the launcher no longer waits for it.
  signal?: AbortSignal;
};

export type ProgramLaunch = {
  // The body of an async function.
  code: string;
  timeoutMs: number;
  // The heap of the process, when not the usual one.
  heapMb?: number;
};

type Verdict = { outcome: 'ok'; value: JsonValue } | { outcome: Exclude<ProgramOutcome, 'ok'>; error: CapabilityError };

type Request = { id: number; kind: 'call' | 'describe'; name: string | null; input: string | null };

// The runs in flight, each with the handle that stops it: the shutdown of
// the app stops them all, and a restart waits while one runs. By the time
// killRunningPrograms returns every process has got its signal and every
// scope has ended.
const runningPrograms = new Set<() => void>();

export function countRunningPrograms(): number {
  return runningPrograms.size;
}

export function killRunningPrograms(): void {
  for (const stop of [...runningPrograms]) {
    stop();
  }
}

// The end of a stream of text, kept whole characters.
function tail(maxChars: number) {
  const decoder = new StringDecoder('utf8');
  let text = '';
  let truncated = false;

  const append = (piece: string) => {
    text += piece;

    if (text.length > maxChars) {
      text = text.slice(-maxChars);
      truncated = true;

      // The cut fell inside a surrogate pair: the half goes too.
      const first = text.charCodeAt(0);

      if (first >= 0xdc00 && first <= 0xdfff) {
        text = text.slice(1);
      }
    }
  };

  return {
    write: (chunk: Buffer) => append(decoder.write(chunk)),
    end: () => append(decoder.end()),
    get text() {
      return text;
    },
    get truncated() {
      return truncated;
    },
  };
}

const TOOK_EFFECT = 'The calls it had completed took effect.';

function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === 'string' && (ERROR_KINDS as readonly string[]).includes(value);
}

// How the program ended by its own account: the report of its process.
function verdictOf(reportText: string): Verdict {
  const report = JSON.parse(reportText) as Record<string, unknown>;
  const line = typeof report.line === 'number' ? report.line : null;
  const failed = (message: string, details?: JsonValue): Verdict => ({
    outcome: 'failed',
    error: new CapabilityError('invalid_input', message, details),
  });

  switch (report.outcome) {
    case 'value':
      return { outcome: 'ok', value: report.value as JsonValue };
    case 'call_error': {
      // The error of a call the program did not catch leaves the run as it
      // is: the same kind, the same fields.
      const error = report.error as { kind?: unknown; message?: unknown; details?: JsonValue };

      if (isErrorKind(error.kind) && typeof error.message === 'string') {
        return { outcome: 'failed', error: new CapabilityError(error.kind, error.message, error.details) };
      }

      return failed(`The program threw an error that is not one of a call: ${JSON.stringify(error)}. ${TOOK_EFFECT}`);
    }
    case 'exception':
      return failed(
        `The program threw${line === null ? '' : ` at line ${line}`}: ${String(report.text)}. ${TOOK_EFFECT}`,
        { line },
      );
    case 'syntax':
      return failed(
        `The program does not parse${line === null ? '' : ` at line ${line}`}: ${String(report.text)}. \`code\` is the body of an async function. Nothing has run.`,
        { line },
      );
    case 'not_json': {
      const where = report.path ? `\`${String(report.path)}\` in what it returned` : 'what it returned';

      return failed(
        `The program ran to its end, and its calls took effect, but ${where} is ${String(report.what)}: a program returns a JSON value, null when there is nothing to say.`,
      );
    }
    default:
      throw new Error(`The process of the program gave a report of an unknown form: ${reportText.slice(0, 200)}`);
  }
}

function seconds(ms: number): string {
  const value = ms / 1000;

  return `${value} second${value === 1 ? '' : 's'}`;
}

// The runner itself: one run of a program under a grant. It never throws —
// whatever happened is the outcome of the run.
export function executeProgram(grant: Grant, launch: ProgramLaunch, env: ProgramEnv): Promise<ProgramRun> {
  const id = randomUUID();
  const startedAt = new Date();
  const ended = new AbortController();
  const scope: ProgramScope = { runId: id, ended: ended.signal };
  const output = tail(CONSOLE_TAIL_CHARS);
  const stderr = tail(STDERR_TAIL_CHARS);

  return new Promise(resolve => {
    let verdict: Verdict | null = null;
    let closed = false;
    // The calls being carried out, by the id the process gave them.
    const inFlight = new Map<number, string>();
    const waiting: Request[] = [];

    const close = () => {
      if (closed) {
        return;
      }

      closed = true;
      runningPrograms.delete(stop);
      env.signal?.removeEventListener('abort', cancel);
      output.end();

      const endedAt = new Date();
      const last: Verdict = verdict ?? {
        outcome: 'failed',
        error: new CapabilityError('internal', 'The run of the program ended without an outcome.'),
      };

      resolve({
        id,
        code: launch.code,
        startedAt,
        endedAt,
        durationMs: endedAt.getTime() - startedAt.getTime(),
        outcome: last.outcome,
        value: last.outcome === 'ok' ? last.value : null,
        error: last.outcome === 'ok' ? null : last.error.toValue(),
        console: output.text,
        consoleTruncated: output.truncated,
      });
    };

    // The first verdict stands: the run is over, its process is killed and
    // its scope has ended. The record is given when the process has closed
    // and its output is read to the end.
    const decide = (next: Verdict) => {
      if (verdict) {
        return;
      }

      verdict = next;
      clearTimeout(timer);
      ended.abort();
      child.kill('SIGKILL');
    };

    const stopped = (why: string) =>
      decide({
        outcome: 'aborted',
        error: new CapabilityError('unavailable', `The program was stopped before it ended: ${why}. ${TOOK_EFFECT}`),
      });
    const stop = () => stopped('Balabash is shutting down');
    const cancel = () => stopped('its run was cancelled');

    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${launch.heapMb ?? PROGRAM_HEAP_MB}`, '-e', PROGRAM_PROCESS],
      // Nothing of the app's environment: the program has no host, and its
      // process needs none.
      { cwd: os.tmpdir(), env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );

    const timer = setTimeout(() => {
      const unfinished = [...inFlight.values()];
      const still = unfinished.length
        ? ` Still running when it was killed: ${unfinished.map(name => `\`${name}\``).join(', ')} — a command is killed with the program, any other call goes on to its end.`
        : '';

      decide({
        outcome: 'timeout',
        error: new CapabilityError(
          'invalid_input',
          `The program ran longer than ${seconds(launch.timeoutMs)} and was killed. ${TOOK_EFFECT}${still}`,
          { unfinishedCalls: unfinished },
        ),
      });
    }, launch.timeoutMs);

    const answer = (request: Request, payload: { ok: true; value: JsonValue } | { ok: false; error: CapabilityErrorValue }) => {
      inFlight.delete(request.id);

      if (!verdict && child.connected) {
        child.send({ type: 'settle', id: request.id, payload: JSON.stringify(payload) });
      }

      pump();
    };

    const carryOut = (request: Request) => {
      inFlight.set(request.id, request.kind === 'describe' ? 'describe' : String(request.name));

      const outcome: Promise<JsonValue> =
        request.kind === 'describe'
          ? describe(grant, request.name === null ? {} : { name: request.name }, env)
          : invokeCapability(grant, String(request.name), request.input === null ? undefined : JSON.parse(request.input), {
              connections: env.connections,
              ...(env.signal ? { signal: env.signal } : {}),
              program: scope,
            });

      outcome.then(
        value => answer(request, { ok: true, value }),
        error => answer(request, { ok: false, error: toCapabilityError(error).toValue() }),
      );
    };

    // A call that has not started when the run is over starts no more.
    const pump = () => {
      while (!verdict && inFlight.size < MAX_CALLS_IN_FLIGHT && waiting.length) {
        carryOut(waiting.shift()!);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => output.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk));

    child.on('message', (message: { type?: string } & Record<string, unknown>) => {
      if (message.type === 'request') {
        waiting.push(message as unknown as Request);
        pump();
      } else if (message.type === 'done') {
        try {
          decide(verdictOf(String(message.report)));
        } catch (error) {
          decide({ outcome: 'failed', error: toCapabilityError(error) });
        }
      }
    });

    // The process could not be started at all.
    child.once('error', error => {
      decide({
        outcome: 'failed',
        error: new CapabilityError('internal', `The process of the program could not be started: ${error.message}`),
      });
      close();
    });

    child.once('close', (exitCode, signal) => {
      stderr.end();

      // The process went away by itself, without a word about the program.
      if (/heap out of memory/i.test(stderr.text)) {
        decide({
          outcome: 'failed',
          error: new CapabilityError(
            'invalid_input',
            `The program ran out of memory (its process has ${launch.heapMb ?? PROGRAM_HEAP_MB} MB) and was killed. ${TOOK_EFFECT}`,
          ),
        });
      } else {
        decide({
          outcome: 'failed',
          error: new CapabilityError(
            'internal',
            `The process of the program ended without an outcome (${signal ? `signal ${signal}` : `exit code ${exitCode}`})${stderr.text ? `: ${stderr.text}` : '.'}`,
          ),
        });
      }

      close();
    });

    runningPrograms.add(stop);

    if (env.signal?.aborted) {
      cancel();
    } else {
      env.signal?.addEventListener('abort', cancel, { once: true });

      // A process that did not start has no channel: its `error` tells it.
      if (child.connected) {
        child.send({ type: 'start', code: launch.code });
      }
    }
  });
}

// The action `run_program`: the launch on the spot. The program acts under
// the grant of the one who called and gives its value to them; whatever went
// wrong leaves as the error of this call.
export async function runProgram(grant: Grant, input: unknown, env: ProgramEnv): Promise<JsonValue> {
  let args: { code: string; timeoutSeconds: number };

  try {
    args = parseActionInput(grant, ACTIONS.run_program, input) as typeof args;
  } catch (error) {
    throw toCapabilityError(error);
  }

  const run = await executeProgram(grant, { code: args.code, timeoutMs: args.timeoutSeconds * 1000 }, env);

  if (run.error) {
    throw new CapabilityError(run.error.kind, run.error.message, run.error.details);
  }

  return run.value;
}
