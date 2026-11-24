// When to reach for the browser sub-agents — for every agent that can spawn
// them: `browser` (a Chromium on the server) and `user_browser` (the Chrome
// of a user of the workspace).
export const BROWSER_SUBAGENT_NOTE =
  'When a task needs a real website operated (logins, forms, JS-heavy pages) rather than fetched, spawn the browser sub-agent (spawn_agent) — a real Chromium session running in a child thread; drive it with send_to_thread. ' +
  "When the site has to be operated as the user — under the logins of their own Chrome, in a tab they have open, or because it does not let the server in — spawn user_browser instead: it works in a browser a user linked to the workspace, and its description says what the instruction must name.";
