// When to reach for the browser sub-agent — for every agent that can spawn it.
export const BROWSER_SUBAGENT_NOTE =
  'When a task needs a real website operated (logins, forms, JS-heavy pages) rather than fetched, spawn the browser sub-agent (spawn_agent) — a real Chromium session running in a child thread; drive it with send_to_thread.';
