// The reasoning effort of a session whose agent names none: the platform's
// own default, explicit rather than trusting an SDK default to stay 'high'.
// One value for both SDK harnesses (the Claude session passes it as
// `effort`, the Codex session as `modelReasoningEffort` — the platform scale
// is a subset of Codex's); the console shows it in the agent catalog.

import type { EffortLevel } from '../core/contract.ts';

export const DEFAULT_EFFORT: EffortLevel = 'high';
