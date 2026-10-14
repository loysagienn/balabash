// The inter-thread verbs send_to_thread, cancel_thread and finish_thread exist on two
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

export const FINISH_THREAD_DESCRIPTION =
  'Finish an active child thread gracefully: the agent is asked to wrap up, write its report and end the ' +
  'thread itself (a remote agent’s session is asked for a closing summary, which becomes the thread’s ' +
  'summary; the session itself stays). NOT instant: the child first finishes its current turn, then wraps ' +
  'up and writes its summary — its thread.completed arrives later, as its reply. Wait for it; do not ' +
  'cancel the thread meanwhile. cancel_thread is the other verb: for work that is no longer needed at all, ' +
  'at once and without a summary.';

// thread.finish delivered to an agent's own run (src/capabilities/session-run.ts,
// agents/browser.ts): the one who asked — the user from a surface, or the
// operator (the parent, the secretary) — wants the thread wrapped up by
// the agent itself: no new work, the report, the end verb. One rendering
// for every runner; the verb is the runner's own — end_thread of the
// session run, `finish` of the browser agent (whose session ends with its
// own tool, after the browser is closed). (A remote thread's engine answers
// the same command by asking the session for its closing summary —
// src/remote/engine.ts.)
export function describeFinishRequest(event: { actor: string; payload: Record<string, unknown> }, endVerb: string = 'end_thread'): string {
  const who = event.actor === 'user' ? 'The user asks' : 'Your operator asks';

  return (
    `[${who} you to finish this thread]\n` +
    'Wrap up now: start nothing new, bring what is in flight to a safe stop, write your final report and ' +
    `end the thread with ${endVerb} in this turn.`
  );
}
