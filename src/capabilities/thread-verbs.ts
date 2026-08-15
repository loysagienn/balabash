// The inter-thread verbs send_to_thread and cancel_thread exist on two
// surfaces — the coordinator's function catalog (src/coordinator/functions.ts)
// and the session-run child tools — one contract, two bundles. The shared
// clauses live here so the two definitions cannot drift; each surface may
// append what is specific to it (how threadIds are learned, extra params).

export const SEND_TO_THREAD_DESCRIPTION =
  'Send a message into an active child thread — the way to drive a child agent: instructions, ' +
  'follow-ups, answers to its questions.';

export const CANCEL_THREAD_DESCRIPTION =
  'Cancel an active child thread — work that is no longer needed, or a run stuck without progress. ' +
  'The thread closes as cancelled; its agent stops.';

export const CANCEL_REASON_PARAM_DESCRIPTION = 'A concise reason, or null when there is none.';
