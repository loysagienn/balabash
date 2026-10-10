// The model an agent's newest session started with — lastModel of the
// agent catalog (src/api/contract.ts AgentView), the one field of the
// catalog the log changes after the snapshot. One rule for both readers:
// readLastModels (src/api/snapshot.ts) applies it to the newest
// session.started row of each agent, the console's agents reducer to every
// session.started of the tail — so the replay equals the snapshot. Pure,
// node-free — the console bundles this file (src/console/tsconfig.json).

// The model a session.started payload names; null when it names none or an
// empty one (the log is read tolerantly) — the newest session's model is
// then unknown, not the previous session's.
export function startedModel(payload: Readonly<Record<string, unknown>>): string | null {
  const { model } = payload;

  return typeof model === 'string' && model !== '' ? model : null;
}
