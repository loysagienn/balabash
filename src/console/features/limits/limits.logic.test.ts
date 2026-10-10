import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ClaudeLimitsView, CodexLimitsView, LimitWindowView } from '../../../api/contract.ts';
import {
  codexMeasuredWords,
  codexReachedWords,
  codexRows,
  codexWindowTitle,
  failureWords,
  isCurrentLimitsShape,
  limitLabel,
  limitLevel,
  limitRows,
  measuredWords,
  noLimitsWords,
  overageWords,
  planWords,
  resetWords,
  windowTitle,
} from './limits.logic.ts';

const NOW = new Date(2026, 9, 10, 16, 38); // October 10, local

function window(partial: Partial<LimitWindowView> & Pick<LimitWindowView, 'kind'>): LimitWindowView {
  return { model: null, utilization: 10, resetsAt: new Date(2026, 9, 10, 18, 0), status: null, ...partial };
}

function view(windows: LimitWindowView[], partial: Partial<ClaudeLimitsView> = {}): ClaudeLimitsView {
  return { measuredAt: new Date(2026, 9, 10, 16, 31), subscriptionType: 'max', available: true, windows, overage: null, ...partial };
}

describe('limits words', () => {
  it('titles the windows: the plan-wide kinds by name, a per-model one by the server’s label', () => {
    assert.equal(windowTitle({ kind: 'five_hour', model: null }), '5 hours');
    assert.equal(windowTitle({ kind: 'seven_day', model: null }), '7 days');
    assert.equal(windowTitle({ kind: 'seven_day_opus', model: null }), '7 days · Opus');
    assert.equal(windowTitle({ kind: 'model', model: 'Fable' }), '7 days · Fable');
  });

  it('says when a window resets: today by the clock, within the week by the weekday, further by the date; a passed reset and an unknown one say so', () => {
    assert.equal(resetWords(new Date(2026, 9, 10, 18, 0), NOW), 'resets at 18:00 · in 1h 22m');
    assert.equal(resetWords(new Date(2026, 9, 14, 10, 0), NOW), 'resets Wed, 10:00 · in 3d 17h');
    assert.equal(resetWords(new Date(2026, 9, 20, 10, 0), NOW), 'resets Oct 20, 10:00 · in 9d 17h');
    assert.equal(resetWords(new Date(2026, 9, 10, 16, 38, 20), NOW), 'resets at 16:38 · in under a minute');
    // The endpoints' jitter around a minute boundary does not move the moment.
    assert.equal(resetWords(new Date(2026, 9, 12, 23, 59, 59, 637), NOW), 'resets Tue, 00:00 · in 2d 7h');
    assert.equal(resetWords(new Date(2026, 9, 13, 0, 0, 0, 360), NOW), 'resets Tue, 00:00 · in 2d 7h');
    assert.equal(resetWords(new Date(2026, 9, 11, 1, 49, 59, 500), NOW), 'resets Sun, 01:50 · in 9h 11m');
    assert.equal(resetWords(new Date(2026, 9, 10, 12, 0), NOW), 'reset at 12:00 passed — measured before it');
    assert.equal(resetWords(new Date(2026, 9, 9, 12, 0), NOW), 'reset Oct 9, 12:00 passed — measured before it');
    assert.equal(resetWords(null, NOW), 'reset time unknown');
  });

  it('labels a window by the ring’s levels, with the overage and a refusal since the measurement', () => {
    const on = { enabled: true, inUse: true, usedCredits: null, monthlyLimit: null, utilization: null, currency: null };

    assert.equal(limitLabel({ utilization: 47, status: null }, null), 'normal');
    assert.equal(limitLabel({ utilization: 80, status: 'allowed_warning' }, null), 'warning');
    assert.equal(limitLabel({ utilization: 100, status: null }, null), 'exhausted');
    assert.equal(limitLabel({ utilization: 100, status: 'rejected' }, on), 'exhausted · overage');
    assert.equal(limitLabel({ utilization: 100, status: null }, { ...on, inUse: false }), 'exhausted');
    assert.equal(limitLabel({ utilization: 95, status: 'rejected' }, null), 'refused');
    assert.equal(limitLabel({ utilization: null, status: null }, null), 'normal');
    // The API's answer since the measurement is newer than its percentage.
    assert.equal(limitLabel({ utilization: 20, status: 'allowed_warning' }, null), 'warning');
    assert.equal(limitLabel({ utilization: 20, status: 'rejected' }, null), 'refused');
    assert.equal(limitLabel({ utilization: 20, status: 'allowed' }, null), 'normal');
    assert.equal(limitLevel({ utilization: 20, status: 'allowed_warning' }), 'warn');
    assert.equal(limitLevel({ utilization: 20, status: 'rejected' }), 'warn');
    assert.equal(limitLevel({ utilization: 100, status: 'allowed' }), 'over');
    assert.equal(limitLevel({ utilization: 20, status: null }), undefined);
  });

  it('rows: Home keeps to the plan-wide and the per-model windows unless an older narrow kind is at a warning; System lists them all; no percentage — no row', () => {
    const limits = view([
      window({ kind: 'five_hour', utilization: 47 }),
      window({ kind: 'seven_day', utilization: 81, resetsAt: new Date(2026, 9, 14, 10, 0) }),
      window({ kind: 'seven_day_oauth_apps', utilization: null, resetsAt: null }),
      window({ kind: 'seven_day_opus', utilization: 12, resetsAt: new Date(2026, 9, 14, 10, 0) }),
      window({ kind: 'model', model: 'Fable', utilization: 63, resetsAt: new Date(2026, 9, 14, 10, 0) }),
      window({ kind: 'model', model: 'Sonnet', utilization: 12, resetsAt: new Date(2026, 9, 14, 10, 0) }),
    ]);

    assert.deepEqual(limitRows(limits, 'home', NOW), [
      { key: 'five_hour', title: '5 hours', meta: 'resets at 18:00 · in 1h 22m', value: 47, label: 'normal', level: undefined },
      { key: 'seven_day', title: '7 days', meta: 'resets Wed, 10:00 · in 3d 17h', value: 81, label: 'warning', level: 'warn' },
      { key: 'model:Fable', title: '7 days · Fable', meta: 'resets Wed, 10:00 · in 3d 17h', value: 63, label: 'normal', level: undefined },
      { key: 'model:Sonnet', title: '7 days · Sonnet', meta: 'resets Wed, 10:00 · in 3d 17h', value: 12, label: 'normal', level: undefined },
    ]);
    assert.deepEqual(
      limitRows(limits, 'all', NOW).map(row => row.key),
      ['five_hour', 'seven_day', 'seven_day_opus', 'model:Fable', 'model:Sonnet'],
    );
  });

  it('rows: a narrow window the API refused or warned about since the measurement is on Home at its low percentage, and leaves once the API allows again', () => {
    const refused = view([window({ kind: 'five_hour', utilization: 47 }), window({ kind: 'seven_day_opus', utilization: 20, status: 'rejected' })]);

    assert.deepEqual(
      limitRows(refused, 'home', NOW).map(row => [row.key, row.label, row.level]),
      [
        ['five_hour', 'normal', undefined],
        ['seven_day_opus', 'refused', 'warn'],
      ],
    );

    const warned = view([window({ kind: 'seven_day_opus', utilization: 20, status: 'allowed_warning' })]);

    assert.deepEqual(limitRows(warned, 'home', NOW).map(row => [row.key, row.label, row.level]), [['seven_day_opus', 'warning', 'warn']]);

    const allowed = view([window({ kind: 'seven_day_opus', utilization: 20, status: 'allowed' })]);

    assert.deepEqual(limitRows(allowed, 'home', NOW), []);
    assert.deepEqual(limitRows(allowed, 'all', NOW).map(row => [row.label, row.level]), [['normal', undefined]]);
  });

  it('the footer: the measurement’s moment and what can refresh it; the overage line when the endpoint spoke of it', () => {
    const limits = view([]);

    assert.equal(measuredWords(limits, 2, NOW), 'measured 16:31 · 2 Claude sessions live');
    assert.equal(measuredWords(limits, 1, NOW), 'measured 16:31 · 1 Claude session live');
    assert.equal(measuredWords(limits, 0, NOW), 'measured 16:31 · no Claude session running — the next run refreshes');
    assert.equal(measuredWords({ ...limits, measuredAt: new Date(2026, 9, 9, 23, 10) }, 0, NOW), 'measured Oct 9, 23:10 · no Claude session running — the next run refreshes');

    assert.equal(overageWords(null), null);
    assert.equal(overageWords({ enabled: false, inUse: false, usedCredits: null, monthlyLimit: null, utilization: null, currency: null }), 'Overage off');
    assert.equal(overageWords({ enabled: true, inUse: false, usedCredits: 4.8, monthlyLimit: 50, utilization: 9.6, currency: 'USD' }), 'Overage on · $4.80 of $50.00 this month');
    assert.equal(
      overageWords({ enabled: true, inUse: true, usedCredits: 4.8, monthlyLimit: null, utilization: null, currency: null }),
      'Overage on · in use: requests past the plan are billed at API rates · $4.80 this month',
    );
    assert.equal(overageWords({ enabled: true, inUse: false, usedCredits: null, monthlyLimit: null, utilization: null, currency: null }), 'Overage on');
    assert.equal(overageWords({ enabled: true, inUse: false, usedCredits: 3, monthlyLimit: null, utilization: null, currency: 'credits' }), 'Overage on · 3 credits this month');
  });

  it('the note without a measurement: a session running but silent, the last session’s end, nothing since the start', () => {
    assert.equal(noLimitsWords({ liveSessions: 2, lastSessionAt: null }, NOW), 'No limit data yet: 2 Claude sessions are running, but none has answered a measurement.');
    assert.equal(noLimitsWords({ liveSessions: 1, lastSessionAt: null }, NOW), 'No limit data yet: 1 Claude session is running, but none has answered a measurement.');
    assert.equal(noLimitsWords({ liveSessions: 0, lastSessionAt: new Date(2026, 9, 10, 12, 40) }, NOW), 'No limit data yet: the last Claude session ended 12:40; the next run measures them.');
    assert.equal(noLimitsWords({ liveSessions: 0, lastSessionAt: null }, NOW), 'No limit data yet: no Claude session has run since the app started; the next run measures them.');
  });

  it('the note of a round that brought nothing: when, and what the control said', () => {
    assert.equal(
      failureWords('Claude', { at: new Date(2026, 9, 10, 16, 35), message: 'get_usage is not supported in this context' }, NOW),
      'Couldn’t measure the Claude limits 16:35: get_usage is not supported in this context',
    );
    assert.equal(failureWords('Codex', { at: new Date(2026, 9, 9, 16, 35), message: 'no answer within 10 s' }, NOW), 'Couldn’t measure the Codex limits Oct 9, 16:35: no answer within 10 s');
  });

  it('the plan of a group’s header: known names, an unknown one capitalised, nothing when not said', () => {
    assert.equal(planWords('max'), 'Max plan');
    assert.equal(planWords('prolite'), 'Pro Lite plan');
    assert.equal(planWords('enterprise_cbp_usage_based'), 'Enterprise Cbp Usage Based plan');
    assert.equal(planWords(null), null);
    assert.equal(planWords(''), null);
  });
});

function codex(partial: Partial<CodexLimitsView> = {}): CodexLimitsView {
  return {
    measuredAt: new Date(2026, 9, 10, 16, 31),
    planType: 'prolite',
    windows: [{ bucket: null, kind: 'primary', windowMinutes: 10080, utilization: 63, resetsAt: new Date(2026, 9, 14, 10, 0) }],
    buckets: [{ bucket: null, reached: null, spendControlReached: false, spendLimit: null }],
    credits: { has: false, unlimited: false, balance: '0' },
    resetCredits: 3,
    ...partial,
  };
}

describe('the shape of the answer', () => {
  it('this build’s contract has both accounts and the Codex buckets; the older server’s shapes are not it', () => {
    const claude = { limits: null, lastFailure: null, liveSessions: 0, lastSessionAt: null };

    assert.equal(isCurrentLimitsShape({ claude, codex: { limits: null, lastFailure: null } }), true);
    assert.equal(isCurrentLimitsShape({ claude, codex: { limits: codex(), lastFailure: null } }), true);
    // The flat answer of the Claude-only build, the two-account answer
    // before the buckets, nothing at all.
    assert.equal(isCurrentLimitsShape(claude), false);
    assert.equal(isCurrentLimitsShape({ claude, codex: { limits: { ...codex(), buckets: undefined, reached: null }, lastFailure: null } }), false);
    assert.equal(isCurrentLimitsShape(null), false);
  });
});

describe('codex limits words', () => {
  it('titles a window by its length, with the bucket when there are several; an unstated length is "window"', () => {
    assert.equal(codexWindowTitle({ windowMinutes: 10080, bucket: null }), '7 days');
    assert.equal(codexWindowTitle({ windowMinutes: 1440, bucket: null }), '1 day');
    assert.equal(codexWindowTitle({ windowMinutes: 300, bucket: null }), '5 hours');
    assert.equal(codexWindowTitle({ windowMinutes: 90, bucket: null }), '90 minutes');
    assert.equal(codexWindowTitle({ windowMinutes: 300, bucket: 'codex' }), '5 hours · codex');
    assert.equal(codexWindowTitle({ windowMinutes: null, bucket: null }), 'window');
    assert.equal(codexWindowTitle({ windowMinutes: 0, bucket: null }), 'window');
  });

  it('rows: every window, labelled by the ring’s levels', () => {
    const limits = codex({
      windows: [
        { bucket: null, kind: 'primary', windowMinutes: 300, utilization: 47, resetsAt: new Date(2026, 9, 10, 18, 0) },
        { bucket: null, kind: 'secondary', windowMinutes: 10080, utilization: 100, resetsAt: null },
      ],
    });

    assert.deepEqual(codexRows(limits, NOW), [
      { key: 'codex::primary', title: '5 hours', meta: 'resets at 18:00 · in 1h 22m', value: 47, label: 'normal', level: undefined },
      { key: 'codex::secondary', title: '7 days', meta: 'reset time unknown', value: 100, label: 'exhausted', level: 'over' },
    ]);
    assert.deepEqual(codexRows(codex({ windows: [] }), NOW), []);
  });

  it('the refusal notes: the backend’s reason in words, the spend control, nothing while requests go through; one per bucket that refuses, named when there are several', () => {
    const one = (reached: string | null, spendControlReached: boolean | null) => codexReachedWords({ buckets: [{ bucket: null, reached, spendControlReached, spendLimit: null }] });

    assert.deepEqual(one(null, false), []);
    assert.deepEqual(one(null, null), []);
    assert.deepEqual(one('rate_limit_reached', false), ['Codex is refusing requests: the rate limit is reached.']);
    assert.deepEqual(one('workspace_owner_credits_depleted', true), ['Codex is refusing requests: the workspace owner’s credits are depleted.']);
    assert.deepEqual(one('something_new', null), ['Codex is refusing requests: something new.']);
    assert.deepEqual(one(null, true), ['Codex is refusing requests: the spend control is reached.']);
    assert.deepEqual(
      codexReachedWords({
        buckets: [
          { bucket: 'codex', reached: null, spendControlReached: false, spendLimit: null },
          { bucket: 'Other models', reached: 'workspace_member_usage_limit_reached', spendControlReached: true, spendLimit: null },
          { bucket: 'Third', reached: null, spendControlReached: true, spendLimit: null },
        ],
      }),
      ['Codex is refusing requests against Other models: the workspace member’s usage limit is reached.', 'Codex is refusing requests against Third: the spend control is reached.'],
    );
  });

  it('the footer: the measurement, the credits as stated, the member’s spend limit, the reset credits', () => {
    assert.equal(codexMeasuredWords(codex(), NOW), 'measured 16:31 · no extra credits · 3 reset credits available');
    assert.equal(codexMeasuredWords(codex({ credits: null, resetCredits: null }), NOW), 'measured 16:31');
    assert.equal(codexMeasuredWords(codex({ credits: { has: true, unlimited: true, balance: null }, resetCredits: 0 }), NOW), 'measured 16:31 · unlimited credits');
    assert.equal(codexMeasuredWords(codex({ credits: { has: true, unlimited: false, balance: '12.50' }, resetCredits: 1 }), NOW), 'measured 16:31 · credits: 12.50 · 1 reset credit available');
    assert.equal(codexMeasuredWords(codex({ credits: { has: true, unlimited: false, balance: null }, resetCredits: null }), NOW), 'measured 16:31 · credits available');
    const spendLimit = { used: '$80', limit: '$100', remainingPercent: 20, resetsAt: new Date(2026, 9, 14, 10, 0) };

    assert.equal(
      codexMeasuredWords(codex({ measuredAt: new Date(2026, 9, 9, 23, 10), credits: null, resetCredits: null, buckets: [{ bucket: null, reached: null, spendControlReached: false, spendLimit }] }), NOW),
      'measured Oct 9, 23:10 · spend limit $80 of $100 (20% left, resets Wed, 10:00 · in 3d 17h)',
    );
    // Several buckets: each spend limit named by its bucket; an unknown
    // reset moment says so.
    assert.equal(
      codexMeasuredWords(
        codex({
          credits: null,
          resetCredits: null,
          buckets: [
            { bucket: 'codex', reached: null, spendControlReached: false, spendLimit: null },
            { bucket: 'Other models', reached: null, spendControlReached: false, spendLimit },
            { bucket: 'Third', reached: null, spendControlReached: false, spendLimit: { ...spendLimit, resetsAt: null } },
          ],
        }),
        NOW,
      ),
      'measured 16:31 · Other models: spend limit $80 of $100 (20% left, resets Wed, 10:00 · in 3d 17h) · Third: spend limit $80 of $100 (20% left, reset time unknown)',
    );
  });
});
