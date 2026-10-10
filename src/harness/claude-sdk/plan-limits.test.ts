// The plan-limits service over fake usage controls: the view of a usage
// answer, the statuses of rate_limit_event frames, when a measurement is
// taken (init, event, stale read — throttled, one at a time), what a read
// answers without a session or with a failing control.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKControlGetUsageResponse, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { FRAME_REFRESH_MS, FRESH_MS, createPlanLimits, limitsOfUsage, withRateLimitInfo } from './plan-limits.ts';

const T0 = Date.parse('2026-10-10T16:00:00Z');

function usage(overrides: Partial<SDKControlGetUsageResponse> = {}): SDKControlGetUsageResponse {
  return {
    session: { total_cost_usd: 0.3, total_api_duration_ms: 1000, total_duration_ms: 2000, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 47, resets_at: '2026-10-10T18:00:00Z' },
      seven_day: { utilization: 81, resets_at: '2026-10-13T10:00:00Z' },
      seven_day_opus: null,
      seven_day_oauth_apps: { utilization: null, resets_at: null },
      model_scoped: [{ display_name: 'Fable', utilization: 100, resets_at: '2026-10-13T10:00:00Z' }],
      extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 4.8, utilization: 9.6, currency: 'USD' },
    },
    behaviors: null,
    ...overrides,
  };
}

function frame(message: Record<string, unknown>): SDKMessage {
  return { uuid: 'u', session_id: 's', ...message } as unknown as SDKMessage;
}

const init = frame({ type: 'system', subtype: 'init', cwd: '/w', tools: [], mcp_servers: [], model: 'm', permissionMode: 'bypassPermissions' });

function rateLimit(info: Record<string, unknown>): SDKMessage {
  return frame({ type: 'rate_limit_event', rate_limit_info: info });
}

describe('limitsOfUsage', () => {
  it('lists the windows the endpoint named, in the plan order then the per-model rows, with the extra usage and the plan', () => {
    const at = new Date(T0);
    const view = limitsOfUsage(usage(), at);

    assert.deepEqual(view, {
      measuredAt: at,
      subscriptionType: 'max',
      available: true,
      windows: [
        { kind: 'five_hour', model: null, utilization: 47, resetsAt: new Date('2026-10-10T18:00:00Z'), status: null },
        { kind: 'seven_day', model: null, utilization: 81, resetsAt: new Date('2026-10-13T10:00:00Z'), status: null },
        // A window with nothing said is still a window of the plan: the console decides how to show "unknown".
        { kind: 'seven_day_oauth_apps', model: null, utilization: null, resetsAt: null, status: null },
        { kind: 'model', model: 'Fable', utilization: 100, resetsAt: new Date('2026-10-13T10:00:00Z'), status: null },
      ],
      overage: { enabled: true, inUse: false, usedCredits: 4.8, monthlyLimit: 50, utilization: 9.6, currency: 'USD' },
    });
  });

  it('an account without plan limits has no windows and no overage; a malformed reset date is null', () => {
    const at = new Date(T0);

    assert.deepEqual(limitsOfUsage(usage({ subscription_type: null, rate_limits_available: false, rate_limits: null }), at), {
      measuredAt: at,
      subscriptionType: null,
      available: false,
      windows: [],
      overage: null,
    });
    assert.equal(limitsOfUsage(usage({ rate_limits: { five_hour: { utilization: 1, resets_at: 'soon' } } }), at).windows[0]!.resetsAt, null);
  });

  it('carries the statuses and the overage-in-use flag of the previous view over by window', () => {
    const previous = withRateLimitInfo(limitsOfUsage(usage(), new Date(T0)), { status: 'allowed_warning', rateLimitType: 'seven_day', isUsingOverage: true });
    const next = limitsOfUsage(usage(), new Date(T0 + 1000), previous);

    assert.deepEqual(
      next.windows.map(w => [w.kind, w.status]),
      [
        ['five_hour', null],
        ['seven_day', 'allowed_warning'],
        ['seven_day_oauth_apps', null],
        ['model', null],
      ],
    );
    assert.equal(next.overage?.inUse, true);
  });
});

describe('withRateLimitInfo', () => {
  const view = limitsOfUsage(usage(), new Date(T0));

  it('stamps the status onto the window the event names and the overage flag; the same view when nothing changes', () => {
    const stamped = withRateLimitInfo(view, { status: 'rejected', rateLimitType: 'five_hour' });

    assert.deepEqual(stamped?.windows[0], { ...view.windows[0], status: 'rejected' });
    assert.equal(stamped?.windows[1], view.windows[1]);
    assert.equal(withRateLimitInfo(stamped, { status: 'rejected', rateLimitType: 'five_hour' }), stamped);

    const overage = withRateLimitInfo(view, { status: 'allowed', rateLimitType: 'overage', overageInUse: true });

    assert.equal(overage?.overage?.inUse, true);
    assert.equal(overage?.windows, view.windows);
  });

  it('invents no window: an unknown kind, an event without a kind, no view', () => {
    assert.equal(withRateLimitInfo(view, { status: 'rejected', rateLimitType: 'seven_day_opus' }), view);
    assert.equal(withRateLimitInfo(view, { status: 'allowed' }), view);
    assert.equal(withRateLimitInfo(null, { status: 'rejected', rateLimitType: 'five_hour' }), null);
  });
});

describe('createPlanLimits', () => {
  function stand(start = T0) {
    let clock = start;
    const warnings: string[] = [];
    const service = createPlanLimits({ now: () => clock, warn: m => warnings.push(m) });

    return { service, warnings, tick: (ms: number) => (clock += ms) };
  }

  it('reads nothing without a session, measures through a session on the init frame and answers the cache after the session ended', async () => {
    const { service, tick } = stand();

    assert.deepEqual(await service.read(), { limits: null, liveSessions: 0, lastSessionAt: null });

    let calls = 0;
    const unregister = service.registerProvider('t1', async () => {
      calls += 1;

      return usage();
    });

    // A frame of a thread without a registered session is not a session's.
    service.observe('other', init);
    assert.equal(calls, 0);

    service.observe('t1', init);
    await service.settled();
    assert.equal(calls, 1);

    const read = await service.read();

    assert.equal(read.liveSessions, 1);
    assert.equal(read.limits?.measuredAt.getTime(), T0);
    assert.equal(read.limits?.windows.length, 4);

    unregister();
    tick(5000);
    service.sessionEnded('t1');

    assert.deepEqual(await service.read(), { limits: read.limits, liveSessions: 0, lastSessionAt: new Date(T0 + 5000) });
    assert.equal(calls, 1);
  });

  it('a read refreshes a stale cache through a live session, shares one measurement and leaves a fresh one alone', async () => {
    const { service, tick } = stand();
    let calls = 0;
    let release: (() => void) | null = null;

    service.registerProvider('t1', () => {
      calls += 1;

      return new Promise(resolve => {
        release = () => resolve(usage());
      });
    });

    const first = service.read();
    const second = service.read();

    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 1);
    release!();

    assert.equal((await first).limits?.measuredAt.getTime(), T0);
    assert.equal((await second).limits?.measuredAt.getTime(), T0);

    tick(FRESH_MS - 1);
    await service.read();
    assert.equal(calls, 1);

    tick(1);
    const third = service.read();

    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 2);
    release!();
    assert.equal((await third).limits?.measuredAt.getTime(), T0 + FRESH_MS);
  });

  it('frames ask for a measurement at most once a minute; the event stamps its status at once and the measurement keeps it', async () => {
    const { service, tick } = stand();
    let calls = 0;

    service.registerProvider('t1', async () => {
      calls += 1;

      return usage();
    });

    service.observe('t1', init);
    await service.settled();
    tick(1000);
    service.observe('t1', rateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day' }));
    await service.settled();
    assert.equal(calls, 1);

    const stamped = await service.read();

    assert.equal(stamped.limits?.windows[1]?.status, 'allowed_warning');

    tick(FRAME_REFRESH_MS);
    service.observe('t1', rateLimit({ status: 'rejected', rateLimitType: 'seven_day' }));
    await service.settled();
    assert.equal(calls, 2);

    const measured = await service.read();

    assert.equal(measured.limits?.measuredAt.getTime(), T0 + 1000 + FRAME_REFRESH_MS);
    assert.equal(measured.limits?.windows[1]?.status, 'rejected');
  });

  it('a failing control is a warning once per message, the cache stays, the next session answers', async () => {
    const { service, warnings, tick } = stand();

    service.registerProvider('t1', async () => {
      throw new Error('get_usage is not supported in this context');
    });
    service.observe('t1', init);
    await service.settled();

    assert.deepEqual(await service.read(), { limits: null, liveSessions: 1, lastSessionAt: null });
    assert.deepEqual(warnings, ['usage control failed: get_usage is not supported in this context']);

    tick(FRESH_MS);
    await service.read();
    assert.equal(warnings.length, 1);

    service.registerProvider('t2', async () => usage());
    tick(FRESH_MS);

    const read = await service.read();

    assert.equal(read.limits?.subscriptionType, 'max');
    assert.equal(read.liveSessions, 2);
  });
});
