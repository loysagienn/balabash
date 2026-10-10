// The agent catalog of the snapshot, by name — the coordinator first, then
// the catalog agents by name, as the server lists them. The tail keeps one
// field fresh: lastModel, the model an agent's newest session started with,
// follows session.started by the rule the snapshot reads with (startedModel,
// src/projections/last-model.ts — a start naming no model leaves the agent
// without one), so the replay equals the snapshot; an agent the catalog does
// not know changes nothing.

import type { AgentView } from '../../../api/contract.ts';
import { startedModel } from '../../../projections/last-model.ts';
import type { Action } from '../types.ts';

export type AgentsState = { byName: Record<string, AgentView>; names: string[] };

export function agentsReducer(state: AgentsState = { byName: {}, names: [] }, action: Action): AgentsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE': {
      const byName: Record<string, AgentView> = {};

      for (const agent of action.snapshot.agents) {
        byName[agent.name] = agent;
      }

      return { byName, names: action.snapshot.agents.map(agent => agent.name) };
    }
    case 'event/session.started': {
      const name = action.event.agentName;

      if (!name || !Object.hasOwn(state.byName, name)) {
        return state;
      }

      const agent = state.byName[name];
      const lastModel = startedModel(action.event.payload);

      if (!agent || agent.lastModel === lastModel) {
        return state;
      }

      return { ...state, byName: { ...state.byName, [name]: { ...agent, lastModel } } };
    }
    default:
      return state;
  }
}
