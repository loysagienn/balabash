import type { AgentView } from '../../../api/contract.ts';
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
    default:
      return state;
  }
}
