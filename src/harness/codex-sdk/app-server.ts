// A short-lived `codex app-server` of the vendored CLI (codex-binary.ts),
// spoken to over stdio in its JSON-RPC protocol — the interface the Codex
// desktop and IDE clients use, documented by the CLI itself (`codex
// app-server generate-json-schema`) — for what a session's `codex exec`
// stream does not carry: the account's plan rate limits
// (`account/rateLimits/read`). One process per question: initialize, the
// `initialized` notification, the request, the answer; stdin closed, the
// server exits on its own (observed: ~0.9 s end to end, no model request).
// The server reads the account from CODEX_HOME — the app's isolated home
// with the operator's ChatGPT login linked in (codex-home.ts), so the
// limits are those of the account the sessions run on.

import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { codexBinary } from './codex-binary.ts';
import { mergeEnv } from '../env.ts';

// The account's rate limits as the app-server answers them
// (GetAccountRateLimitsResponse of the protocol, v2), checked field by
// field at the process boundary (rateLimitsOfResult): the historical
// single-bucket snapshot and, when the backend meters several limits, the
// snapshot of each keyed by its limit id. What the backend did not say is
// null; what it said in another shape is a failed round, not a view.
export type CodexRateLimitWindow = {
  usedPercent: number;
  // Unix seconds.
  resetsAt: number | null;
  windowDurationMins: number | null;
};

export type CodexCreditsSnapshot = { hasCredits: boolean; unlimited: boolean; balance: string | null };
export type CodexSpendLimitSnapshot = { limit: string; used: string; remainingPercent: number; resetsAt: number };

export type CodexRateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  planType: string | null;
  rateLimitReachedType: string | null;
  spendControlReached: boolean | null;
  credits: CodexCreditsSnapshot | null;
  individualLimit: CodexSpendLimitSnapshot | null;
};

export type CodexRateLimitsResponse = {
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot> | null;
  rateLimitResetCredits: { availableCount: number } | null;
};

export type AppServerCommand = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

// The command of the real server: the vendored binary with its helper
// directories ahead of PATH (as the SDK runs it) in the given home.
export function codexAppServerCommand(codexHome: string): AppServerCommand {
  const binary = codexBinary();
  const env = mergeEnv({ CODEX_HOME: codexHome });
  const current = (env.PATH ?? '').split(path.delimiter).filter(entry => entry.length > 0 && !binary.pathDirs.includes(entry));

  env.PATH = [...binary.pathDirs, ...current].join(path.delimiter);

  return { command: binary.executablePath, args: ['app-server'], env };
}

export type ReadRateLimitsOptions = {
  command: AppServerCommand;
  // Ends the round: the process is killed, the promise rejects with the
  // signal's reason.
  signal?: AbortSignal;
};

const CLIENT_INFO = { name: 'balabash', version: '1' };
// After stdin is closed the server exits by itself; a server still alive
// after this is killed.
const EXIT_GRACE_MS = 2_000;
const STDERR_TAIL = 2_000;

// A plain object: arrays are not snapshots, windows or maps here.
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformed(where: string): never {
  throw new Error(`account/rateLimits/read answered with a malformed ${where}`);
}

// The checks of one field, named by its place in the answer. An absent or
// null field is null where the protocol allows it (`optional`); a field
// present in another shape fails the round.
function objectAt(value: unknown, where: string): Record<string, unknown> {
  return isObject(value) ? value : malformed(where);
}

function stringAt(value: unknown, where: string): string {
  return typeof value === 'string' ? value : malformed(where);
}

function booleanAt(value: unknown, where: string): boolean {
  return typeof value === 'boolean' ? value : malformed(where);
}

function numberAt(value: unknown, where: string): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : malformed(where);
}

function optional<T>(value: unknown, where: string, check: (value: unknown, where: string) => T): T | null {
  return value === undefined || value === null ? null : check(value, where);
}

function windowAt(value: unknown, where: string): CodexRateLimitWindow {
  const raw = objectAt(value, where);

  return {
    usedPercent: numberAt(raw.usedPercent, `${where}.usedPercent`),
    resetsAt: optional(raw.resetsAt, `${where}.resetsAt`, numberAt),
    windowDurationMins: optional(raw.windowDurationMins, `${where}.windowDurationMins`, numberAt),
  };
}

function creditsAt(value: unknown, where: string): CodexCreditsSnapshot {
  const raw = objectAt(value, where);

  return {
    hasCredits: booleanAt(raw.hasCredits, `${where}.hasCredits`),
    unlimited: booleanAt(raw.unlimited, `${where}.unlimited`),
    balance: optional(raw.balance, `${where}.balance`, stringAt),
  };
}

function spendLimitAt(value: unknown, where: string): CodexSpendLimitSnapshot {
  const raw = objectAt(value, where);

  return {
    limit: stringAt(raw.limit, `${where}.limit`),
    used: stringAt(raw.used, `${where}.used`),
    remainingPercent: numberAt(raw.remainingPercent, `${where}.remainingPercent`),
    resetsAt: numberAt(raw.resetsAt, `${where}.resetsAt`),
  };
}

function snapshotAt(value: unknown, where: string): CodexRateLimitSnapshot {
  const raw = objectAt(value, where);

  return {
    limitId: optional(raw.limitId, `${where}.limitId`, stringAt),
    limitName: optional(raw.limitName, `${where}.limitName`, stringAt),
    primary: optional(raw.primary, `${where}.primary`, windowAt),
    secondary: optional(raw.secondary, `${where}.secondary`, windowAt),
    // The plan and the refusal are enums of the protocol; a value this
    // build does not know is still a string to show, so the check stops at
    // the type.
    planType: optional(raw.planType, `${where}.planType`, stringAt),
    rateLimitReachedType: optional(raw.rateLimitReachedType, `${where}.rateLimitReachedType`, stringAt),
    spendControlReached: optional(raw.spendControlReached, `${where}.spendControlReached`, booleanAt),
    credits: optional(raw.credits, `${where}.credits`, creditsAt),
    individualLimit: optional(raw.individualLimit, `${where}.individualLimit`, spendLimitAt),
  };
}

// The body of a rate-limits answer as the typed response: every field the
// console shows is checked for its type (the schema of the protocol:
// strings, booleans, finite numbers, the required ones present); the rest
// of the body is dropped. Fails with the place of the first field that is
// not what the protocol says — the round's failure, the measurement
// before it kept.
export function rateLimitsOfResult(result: unknown): CodexRateLimitsResponse {
  if (!isObject(result) || !isObject(result.rateLimits)) {
    throw new Error('account/rateLimits/read answered without a rateLimits snapshot');
  }

  let byLimitId: Record<string, CodexRateLimitSnapshot> | null = null;

  if (result.rateLimitsByLimitId !== undefined && result.rateLimitsByLimitId !== null) {
    byLimitId = {};

    for (const [id, snapshot] of Object.entries(objectAt(result.rateLimitsByLimitId, 'rateLimitsByLimitId'))) {
      byLimitId[id] = snapshotAt(snapshot, `rateLimitsByLimitId.${id}`);
    }
  }

  const resetCredits = optional(result.rateLimitResetCredits, 'rateLimitResetCredits', objectAt);

  return {
    rateLimits: snapshotAt(result.rateLimits, 'rateLimits'),
    rateLimitsByLimitId: byLimitId,
    rateLimitResetCredits: resetCredits ? { availableCount: numberAt(resetCredits.availableCount, 'rateLimitResetCredits.availableCount') } : null,
  };
}

// One question to a fresh app-server: initialize, `initialized`,
// `account/rateLimits/read`; resolves with the checked body, rejects with
// what went wrong — the server's error for the request, a process that
// exited before answering (with the tail of its stderr), a spawn failure,
// the signal's reason.
export function readCodexRateLimits({ command, signal }: ReadRateLimitsOptions): Promise<CodexRateLimitsResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));

      return;
    }

    const child = spawn(command.command, command.args, { env: command.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stderr = '';
    let killTimer: NodeJS.Timeout | null = null;

    const finish = (outcome: { value: CodexRateLimitsResponse } | { error: Error }) => {
      if (settled) {
        return;
      }

      settled = true;
      signal?.removeEventListener('abort', onAbort);

      if ('value' in outcome) {
        resolve(outcome.value);
      } else {
        reject(outcome.error);
      }

      // The answer is in: let the server go. It exits on a closed stdin;
      // one that does not is killed. Ending a pipe the server already
      // dropped fails on the stream — the error listener below takes it.
      child.stdin.end();
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, EXIT_GRACE_MS);
      killTimer.unref();
    };

    const onAbort = () => {
      finish({ error: signal!.reason instanceof Error ? signal!.reason : new Error(String(signal!.reason)) });
      child.kill('SIGKILL');
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    // Nothing is written once the round is over: the server may have gone,
    // and stdin is ended by then.
    const send = (message: Record<string, unknown>) => {
      if (!settled) {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      }
    };

    // The three pipes are EventEmitters of their own: an error on any of
    // them (EPIPE when the server drops its input before the round is
    // over, a pipe torn down with the process) is this round's failure —
    // never an unhandled 'error' event, which would end the app process.
    // After the round the pipes' errors have nothing to say.
    child.stdin.on('error', (error: Error) => finish({ error: new Error(`codex app-server stdin: ${error.message}`) }));
    child.stdout.on('error', (error: Error) => finish({ error: new Error(`codex app-server stdout: ${error.message}`) }));
    child.stderr.on('error', (error: Error) => finish({ error: new Error(`codex app-server stderr: ${error.message}`) }));

    child.on('error', error => finish({ error: new Error(`codex app-server could not start: ${error.message}`) }));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });

    child.on('exit', (code, exitSignal) => {
      if (killTimer) {
        clearTimeout(killTimer);
      }

      const tail = stderr.trim().split('\n').at(-1) ?? '';

      finish({ error: new Error(`codex app-server exited before answering (${exitSignal ?? `code ${code}`})${tail ? `: ${tail}` : ''}`) });
    });

    const lines = readline.createInterface({ input: child.stdout });

    lines.on('line', line => {
      // A line after the round is over (a late or repeated answer) is not
      // the protocol any more.
      if (settled) {
        return;
      }

      let message: unknown;

      try {
        message = JSON.parse(line);
      } catch {
        // The server's stdout carries only JSON-RPC lines; anything else is
        // noise.
        return;
      }

      if (!isObject(message)) {
        return;
      }

      if (message.id === 1) {
        if ('error' in message) {
          finish({ error: new Error(`codex app-server refused initialize: ${errorText(message.error)}`) });

          return;
        }

        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read' });
      } else if (message.id === 2) {
        if ('error' in message) {
          finish({ error: new Error(`account/rateLimits/read: ${errorText(message.error)}`) });

          return;
        }

        try {
          finish({ value: rateLimitsOfResult(message.result) });
        } catch (error) {
          finish({ error: error instanceof Error ? error : new Error(String(error)) });
        }
      }
    });

    send({ id: 1, method: 'initialize', params: { clientInfo: CLIENT_INFO } });
  });
}

function errorText(error: unknown): string {
  if (isObject(error) && typeof error.message === 'string') {
    return typeof error.code === 'number' ? `${error.message} (code ${error.code})` : error.message;
  }

  return JSON.stringify(error);
}
