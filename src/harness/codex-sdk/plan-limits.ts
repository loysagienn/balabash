// The Codex account's rate limits (the console's "Plan limits" card, GET
// /api/limits): a measurement the app takes through a short-lived
// app-server of the vendored CLI (app-server.ts — `account/rateLimits/read`
// over stdio, no session and no model request involved), kept in the
// process's memory as the newest known value. The account is the host's
// ChatGPT login linked into the app's CODEX_HOME: one for the whole process,
// so one measurement serves every reader. The SDK's own stream
// (`@openai/codex-sdk`, turn.completed.usage) carries the tokens of a turn
// and nothing of the plan — the app-server is where the CLI itself reads
// the plan's windows for its clients.
//
// When: a read of the cache older than FRESH_MS — nothing else asks; a
// measurement is one process of about a second, so a reader waits for a
// fresh one (up to READ_WAIT_MS) rather than being told stale numbers. One
// measurement in flight at a time; a round that fails (the server's error,
// a process that exited, no answer within ATTEMPT_MS) leaves the cache as
// it is and tells the reader its outcome (lastFailure), cleared by the next
// measurement. Without a provider (a test stand, a host without the CLI)
// the cache stands: null until something measures.

import type { CodexBucketView, CodexLimitWindowView, CodexLimitsResponse, CodexLimitsView, LimitFailureView } from '../../api/contract.ts';
import type { CodexRateLimitSnapshot, CodexRateLimitWindow, CodexRateLimitsResponse } from './app-server.ts';
import { codexAppServerCommand, readCodexRateLimits } from './app-server.ts';
import { ensureCodexHome } from './codex-home.ts';

// A measurement younger than this answers a read as it is.
export const FRESH_MS = 30_000;
// A read waits this long for a measurement in flight, then answers the cache.
export const READ_WAIT_MS = 8_000;
// One round is given this long to answer before it is abandoned.
export const ATTEMPT_MS = 10_000;

// Answers the account's rate limits; the signal ends the attempt.
export type CodexLimitsProvider = (signal: AbortSignal) => Promise<CodexRateLimitsResponse>;

// Unix seconds as a Date; null when the backend did not say, or said a
// number no date can hold.
function dateOfSeconds(seconds: number | null): Date | null {
  if (seconds === null) {
    return null;
  }

  const date = new Date(seconds * 1000);

  return Number.isNaN(date.getTime()) ? null : date;
}

function windowOf(bucket: string | null, kind: CodexLimitWindowView['kind'], raw: CodexRateLimitWindow): CodexLimitWindowView {
  return { bucket, kind, windowMinutes: raw.windowDurationMins, utilization: raw.usedPercent, resetsAt: dateOfSeconds(raw.resetsAt) };
}

// The app-server's answer as the console's view: every metered bucket (the
// keyed snapshots when the backend sent them, else the historical one; a
// bucket is named only when there are several) with its windows and the
// facts it states — the refusal, the spend control, the member's spend
// limit; the plan and the credits of the historical snapshot — the account's.
export function limitsOfRateLimits(response: CodexRateLimitsResponse, measuredAt: Date): CodexLimitsView {
  const keyed = response.rateLimitsByLimitId ? Object.entries(response.rateLimitsByLimitId) : null;
  const snapshots: [string | null, CodexRateLimitSnapshot][] = keyed && keyed.length > 0 ? keyed.map(([id, snapshot]) => [snapshot.limitName ?? snapshot.limitId ?? id, snapshot]) : [[null, response.rateLimits]];
  const windows: CodexLimitWindowView[] = [];
  const buckets: CodexBucketView[] = [];

  for (const [name, snapshot] of snapshots) {
    const bucket = snapshots.length > 1 ? name : null;

    if (snapshot.primary) {
      windows.push(windowOf(bucket, 'primary', snapshot.primary));
    }

    if (snapshot.secondary) {
      windows.push(windowOf(bucket, 'secondary', snapshot.secondary));
    }

    const spend = snapshot.individualLimit;

    buckets.push({
      bucket,
      reached: snapshot.rateLimitReachedType,
      spendControlReached: snapshot.spendControlReached,
      spendLimit: spend ? { used: spend.used, limit: spend.limit, remainingPercent: spend.remainingPercent, resetsAt: dateOfSeconds(spend.resetsAt) } : null,
    });
  }

  const account = response.rateLimits;
  const credits = account.credits;

  return {
    measuredAt,
    planType: account.planType,
    windows,
    buckets,
    credits: credits ? { has: credits.hasCredits, unlimited: credits.unlimited, balance: credits.balance } : null,
    resetCredits: response.rateLimitResetCredits?.availableCount ?? null,
  };
}

export type CodexPlanLimitsService = {
  // What measures: the app registers the real app-server at boot; null
  // leaves the cache as it is.
  setProvider(provider: CodexLimitsProvider | null): void;
  // The console's read: a fresh-enough cache as it is; otherwise a
  // measurement when it answers within READ_WAIT_MS, else the cache — and
  // the outcome of the last round since the cache's measurement that
  // brought none.
  read(): Promise<CodexLimitsResponse>;
  // The measurement in flight, if any — for a test to settle on.
  settled(): Promise<void>;
};

export type CodexPlanLimitsDeps = {
  now?: () => number;
  // Where a failed round is reported (once per distinct message).
  warn?: (message: string) => void;
  // How long one round is given (ATTEMPT_MS; a test shortens it).
  attemptMs?: number;
};

export function createCodexPlanLimits(deps: CodexPlanLimitsDeps = {}): CodexPlanLimitsService {
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? ((message: string) => console.warn(`[codex-limits] ${message}`));
  const attemptMs = deps.attemptMs ?? ATTEMPT_MS;
  let provider: CodexLimitsProvider | null = null;
  let limits: CodexLimitsView | null = null;
  let lastFailure: LimitFailureView | null = null;
  let inFlight: Promise<void> | null = null;
  let lastWarning: string | null = null;

  const measure = async (measureWith: CodexLimitsProvider): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`no answer within ${attemptMs / 1000} s`)), attemptMs);

    try {
      const response = await measureWith(controller.signal);

      limits = limitsOfRateLimits(response, new Date(now()));
      lastFailure = null;
      lastWarning = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      lastFailure = { at: new Date(now()), message };

      if (message !== lastWarning) {
        lastWarning = message;
        warn(`rate limits read failed: ${message}`);
      }
    } finally {
      clearTimeout(timer);
    }
  };

  // One measurement at a time; callers share the one in flight.
  const refresh = (): Promise<void> => {
    if (!inFlight) {
      if (!provider) {
        return Promise.resolve();
      }

      inFlight = measure(provider).finally(() => {
        inFlight = null;
      });
    }

    return inFlight;
  };

  return {
    setProvider(next) {
      provider = next;
    },

    async read() {
      const stale = limits === null || now() - limits.measuredAt.getTime() >= FRESH_MS;

      if (stale && provider) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, READ_WAIT_MS);

          void refresh().finally(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }

      return { limits, lastFailure };
    },

    settled: () => inFlight ?? Promise.resolve(),
  };
}

// The process's one service: the app registers the app-server at boot
// (startCodexPlanLimits), the API reads from here.
export const codexPlanLimits = createCodexPlanLimits();

// Gives the service the real measurement: a fresh app-server in the app's
// CODEX_HOME per round. Returns the function that takes it away again.
export function startCodexPlanLimits(service: CodexPlanLimitsService = codexPlanLimits): () => void {
  service.setProvider(signal => readCodexRateLimits({ command: codexAppServerCommand(ensureCodexHome()), signal }));

  return () => service.setProvider(null);
}
