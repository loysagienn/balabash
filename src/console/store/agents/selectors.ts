import type { AgentView } from '../../../api/contract.ts';
import type { State } from '../types.ts';

// The agent of the catalog by name, or null when the catalog has no such
// agent. `byName` is a plain object: a name from the URL that happens to be
// a key of Object.prototype ("constructor", "__proto__", "toString") would
// read the inherited value, so only an own entry counts.
export function agentOf(byName: Record<string, AgentView>, name: string): AgentView | null {
  return Object.hasOwn(byName, name) ? (byName[name] ?? null) : null;
}

export const selectAgent = (state: State, name: string): AgentView | null => agentOf(state.agents.byName, name);
