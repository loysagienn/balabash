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
// (GetAccountRateLimitsResponse of the protocol, v2): the historical
// single-bucket snapshot and, when the backend meters several limits, the
// snapshot of each keyed by its limit id. The fields the console shows are
// typed; the rest of the body is passed through untyped.
export type CodexRateLimitWindow = {
  usedPercent: number;
  // Unix seconds.
  resetsAt?: number | null;
  windowDurationMins?: number | null;
};

export type CodexRateLimitSnapshot = {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
  spendControlReached?: boolean | null;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string | null } | null;
  individualLimit?: { limit: string; used: string; remainingPercent: number; resetsAt: number } | null;
};

export type CodexRateLimitsResponse = {
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
  rateLimitResetCredits?: { availableCount: number } | null;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// The body of a rate-limits answer, checked where the console depends on
// it: a snapshot object with windows that carry a numeric percentage.
export function rateLimitsOfResult(result: unknown): CodexRateLimitsResponse {
  if (!isObject(result) || !isObject(result.rateLimits)) {
    throw new Error('account/rateLimits/read answered without a rateLimits snapshot');
  }

  const buckets = [result.rateLimits];

  if (result.rateLimitsByLimitId !== undefined && result.rateLimitsByLimitId !== null) {
    if (!isObject(result.rateLimitsByLimitId)) {
      throw new Error('account/rateLimits/read answered with a malformed rateLimitsByLimitId');
    }

    buckets.push(...Object.values(result.rateLimitsByLimitId).filter(isObject));
  }

  for (const bucket of buckets) {
    for (const kind of ['primary', 'secondary'] as const) {
      const window = bucket[kind];

      if (window !== undefined && window !== null && (!isObject(window) || typeof window.usedPercent !== 'number')) {
        throw new Error(`account/rateLimits/read answered with a malformed ${kind} window`);
      }
    }
  }

  return result as CodexRateLimitsResponse;
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
      // one that does not is killed.
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

    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, error => {
        if (error && !settled) {
          finish({ error: new Error(`codex app-server stdin: ${error.message}`) });
        }
      });
    };

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
