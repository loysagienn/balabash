// The plan's rate limits (the console's "Claude limits" cards, GET
// /api/limits): a measurement the inner CLI of a live Claude session takes
// on request — the SDK control `get_usage` reads the claude.ai usage
// endpoint — kept in the process's memory as the newest known value. The
// account is the host's Claude login: one for the whole process, so one
// measurement serves every session and every reader.
//
// Who measures: any live session (sdk-session.ts registers each session's
// control here, like context-usage.ts does for the context window). When:
// a session's init frame (the first measurement of a run, and a fresh one
// when the console is not even open), a rate_limit_event (the API said the
// limits moved), and a read of the cache older than FRESH_MS — each through
// the same throttled refresh. Between measurements, the rate_limit_event
// frames stamp their status (warning, refusal) onto the window they name:
// their percentage is not taken — the control documents its units, the
// event does not.
//
// Without a live session the cache stands as it is; the reader learns how
// many sessions are alive and when the last one ended, and says so. A
// control that fails (the SDK marks it experimental; a CLI may refuse it in
// its context) is "no measurement", never a session failure: the session
// goes on, the cache stays.

import type { SDKControlGetUsageResponse, SDKMessage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeLimitsView, LimitWindowKind, LimitWindowView, LimitsResponse } from '../../api/contract.ts';
import { subscribeSdkSessionEnd, subscribeSdkStream } from './stream-tap.ts';

export type UsageProvider = () => Promise<SDKControlGetUsageResponse>;

// A measurement younger than this answers a read as it is.
export const FRESH_MS = 30_000;
// Frames (init, rate_limit_event) ask for a measurement at most this often.
export const FRAME_REFRESH_MS = 60_000;
// A read waits this long for a measurement in flight, then answers the cache.
export const READ_WAIT_MS = 8_000;
// Providers tried per refresh before giving up on this round.
const PROVIDER_ATTEMPTS = 3;

type Windows = NonNullable<SDKControlGetUsageResponse['rate_limits']>;
type PlanWindow = NonNullable<Windows['five_hour']>;

const PLAN_WINDOWS: Exclude<LimitWindowKind, 'model'>[] = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'];

function dateOf(iso: string | null | undefined): Date | null {
  if (!iso) {
    return null;
  }

  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? null : date;
}

function windowOf(kind: LimitWindowKind, model: string | null, raw: PlanWindow): LimitWindowView {
  return { kind, model, utilization: raw.utilization ?? null, resetsAt: dateOf(raw.resets_at), status: null };
}

// The response of the usage control as the console's view: every window the
// endpoint named (a plan-wide kind that is null or absent is not a window;
// the per-model rows keep the server's label), the extra-usage block, the
// plan. The statuses of a previous view are carried over by window — they
// came after the previous measurement and say how the API answered since.
export function limitsOfUsage(response: SDKControlGetUsageResponse, measuredAt: Date, previous: ClaudeLimitsView | null = null): ClaudeLimitsView {
  const limits = response.rate_limits;
  const windows: LimitWindowView[] = [];

  if (limits) {
    for (const kind of PLAN_WINDOWS) {
      const raw = limits[kind];

      if (raw) {
        windows.push(windowOf(kind, null, raw));
      }
    }

    for (const scoped of limits.model_scoped ?? []) {
      windows.push(windowOf('model', scoped.display_name, scoped));
    }
  }

  for (const window of windows) {
    const before = previous?.windows.find(w => w.kind === window.kind && w.model === window.model);

    if (before && before.status !== null) {
      window.status = before.status;
    }
  }

  const extra = limits?.extra_usage ?? null;

  return {
    measuredAt,
    subscriptionType: response.subscription_type,
    available: response.rate_limits_available,
    windows,
    overage: extra
      ? {
          enabled: extra.is_enabled,
          inUse: previous?.overage?.inUse ?? false,
          usedCredits: extra.used_credits,
          monthlyLimit: extra.monthly_limit,
          utilization: extra.utilization,
          currency: extra.currency ?? null,
        }
      : null,
  };
}

// A rate_limit_event over the view: the status of the window it names, the
// overage flags. A window the view does not have is not invented (its
// percentage is unknown); without a view there is nothing to stamp — the
// refresh the event triggers brings the measurement. Returns the same view
// when nothing changed.
export function withRateLimitInfo(limits: ClaudeLimitsView | null, info: SDKRateLimitInfo): ClaudeLimitsView | null {
  if (!limits) {
    return null;
  }

  let changed = false;
  let windows = limits.windows;
  const kind = info.rateLimitType;

  if (kind && kind !== 'overage' && kind !== 'seven_day_overage_included') {
    windows = limits.windows.map(window => {
      if (window.kind !== kind || window.status === info.status) {
        return window;
      }

      changed = true;

      return { ...window, status: info.status };
    });
  }

  let overage = limits.overage;
  const inUse = info.isUsingOverage ?? info.overageInUse;

  if (overage && inUse !== undefined && overage.inUse !== inUse) {
    overage = { ...overage, inUse };
    changed = true;
  }

  return changed ? { ...limits, windows, overage } : limits;
}

export type PlanLimitsService = {
  // The usage control of a thread's live session; the returned function
  // removes this registration only (a successor session of the same thread
  // is never unregistered by its predecessor's late close).
  registerProvider(threadId: string, provider: UsageProvider): () => void;
  // A frame of the stream tap under a thread.
  observe(threadId: string, message: SDKMessage): void;
  // The harness closed a thread's session.
  sessionEnded(threadId: string): void;
  // The console's read: a fresh-enough cache as it is; otherwise a
  // measurement through a live session when one answers within READ_WAIT_MS,
  // else the cache.
  read(): Promise<LimitsResponse>;
  // The measurement in flight, if any — for a test to settle on.
  settled(): Promise<void>;
};

export type PlanLimitsDeps = {
  now?: () => number;
  // Where a failed control is reported (once per distinct message).
  warn?: (message: string) => void;
};

export function createPlanLimits(deps: PlanLimitsDeps = {}): PlanLimitsService {
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? ((message: string) => console.warn(`[plan-limits] ${message}`));
  const providers = new Map<string, UsageProvider>();
  let limits: ClaudeLimitsView | null = null;
  let lastSessionAt: Date | null = null;
  // The moment a frame last asked for a measurement (throttle).
  let frameRefreshAt = -Infinity;
  let inFlight: Promise<void> | null = null;
  let lastWarning: string | null = null;

  const measure = async (): Promise<void> => {
    const candidates = [...providers.values()].slice(0, PROVIDER_ATTEMPTS);

    for (const provider of candidates) {
      try {
        const response = await provider();
        const measuredAt = new Date(now());

        limits = limitsOfUsage(response, measuredAt, limits);
        lastWarning = null;

        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message !== lastWarning) {
          lastWarning = message;
          warn(`usage control failed: ${message}`);
        }
      }
    }
  };

  // One measurement at a time; callers share the one in flight.
  const refresh = (): Promise<void> => {
    if (!inFlight) {
      if (providers.size === 0) {
        return Promise.resolve();
      }

      inFlight = measure().finally(() => {
        inFlight = null;
      });
    }

    return inFlight;
  };

  const refreshFromFrame = () => {
    const at = now();

    if (at - frameRefreshAt < FRAME_REFRESH_MS) {
      return;
    }

    frameRefreshAt = at;
    void refresh();
  };

  return {
    registerProvider(threadId, provider) {
      providers.set(threadId, provider);

      return () => {
        if (providers.get(threadId) === provider) {
          providers.delete(threadId);
        }
      };
    },

    observe(threadId, message) {
      if (!providers.has(threadId)) {
        return;
      }

      if (message.type === 'system' && message.subtype === 'init') {
        refreshFromFrame();
      } else if (message.type === 'rate_limit_event') {
        limits = withRateLimitInfo(limits, message.rate_limit_info);
        refreshFromFrame();
      }
    },

    sessionEnded() {
      lastSessionAt = new Date(now());
    },

    async read() {
      const stale = limits === null || now() - limits.measuredAt.getTime() >= FRESH_MS;

      if (stale && providers.size > 0) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, READ_WAIT_MS);

          void refresh().finally(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }

      return { limits, liveSessions: providers.size, lastSessionAt };
    },

    settled: () => inFlight ?? Promise.resolve(),
  };
}

// The process's one service: the harness registers sessions here, the API
// reads from here.
export const planLimits = createPlanLimits();

// Subscribes the service to the stream tap and the end of sessions; returns
// the unsubscribe. Started before the router (app.ts), so no session's init
// frame goes unobserved.
export function startPlanLimitsWatch(service: PlanLimitsService = planLimits): () => void {
  const unsubscribeStream = subscribeSdkStream((threadId, message) => service.observe(threadId, message));
  const unsubscribeEnd = subscribeSdkSessionEnd(threadId => service.sessionEnded(threadId));

  return () => {
    unsubscribeStream();
    unsubscribeEnd();
  };
}
