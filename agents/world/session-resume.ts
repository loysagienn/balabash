// What a session reads when the app restarted under it and its run resumed
// the SDK's own saved session (src/capabilities/resume-runs.ts). Two
// situations: the thread was between turns — the note rides in front of the
// message that wakes it; a turn was in flight — the note alone opens the
// continuation, at once. The browser agent adds a line about its browser.

export const SESSION_RESUMED_IDLE_NOTE =
  '[Balabash event] The Balabash app restarted while you were between turns. This session was resumed from its saved ' +
  'history — nothing of the conversation is lost; processes you had started (background shells, servers) did not ' +
  'survive. The message that woke you follows.';

export const SESSION_RESUMED_INTERRUPTED_NOTE =
  '[Balabash event] The Balabash app restarted while your turn was in progress. This session was resumed from its saved ' +
  'history, but that turn was cut off: a tool call may have run without its result reaching you, and processes you had ' +
  'started (background shells, servers) did not survive. Check what actually got done, then carry on with the task — ' +
  'nobody has written to you since.';

export const BROWSER_RELAUNCHED_NOTE =
  'The browser was relaunched with the restart: its profile and logins are kept, the tabs that were open are gone.';
