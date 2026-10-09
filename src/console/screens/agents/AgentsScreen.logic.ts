// The words and rules of the Agents screen: the catalog search, the engine
// names, the mode of an agent, the summary of the filter bar, the shell of
// the split view (the selected agent is a detail screen on the phone, a
// panel beside the catalog when wide) and the next route of a filter
// change. Pure, tested.

import type { AgentView } from '../../../api/contract.ts';
import type { AgentsRoute, AppRoute } from '../../lib/router/routes.ts';
import { countOf } from '../../lib/format/index.ts';
import type { SnapshotStage } from '../../store/stream/selectors.ts';

// The search looks through the name and the description, case-insensitive.
export function agentMatches(agent: Pick<AgentView, 'name' | 'description'>, q: string | undefined): boolean {
  const needle = q?.trim().toLowerCase();

  if (!needle) {
    return true;
  }

  return agent.name.toLowerCase().includes(needle) || agent.description.toLowerCase().includes(needle);
}

// The engine in the catalog row ("Claude") and in the details ("Claude Agent SDK").
export function engineLabel(sdk: AgentView['sdk']): string {
  return sdk === 'codex' ? 'Codex' : 'Claude';
}

export function engineName(sdk: AgentView['sdk']): string {
  return sdk === 'codex' ? 'Codex SDK' : 'Claude Agent SDK';
}

export function modeLabel(headless: boolean): string {
  return headless ? 'headless · no user surface' : 'with the user · not headless';
}

// "11 agents · 4 active threads" above the catalog.
export function agentsSummary(agents: number, running: number): string {
  return `${countOf(agents, 'agent')} · ${countOf(running, 'active thread')}`;
}

export type AgentsFilterPatch = Partial<Omit<AgentsRoute, 'key'>>;

// The next route of a change: an undefined or empty value drops the key, so
// the URL stays canonical.
export function withAgentsFilters(route: AgentsRoute, patch: AgentsFilterPatch): AgentsRoute {
  const next: AgentsRoute = { ...route, ...patch };

  for (const key of ['name', 'q'] as const) {
    if (next[key] === undefined || next[key] === '') {
      delete next[key];
    }
  }

  return next;
}

export type AgentsDetail = 'pick' | 'agent' | 'unknown' | 'loading';

// What the details panel shows — the panel is the whole screen on the phone
// when an agent is named, so the first snapshot in flight shows there too
// (the catalog with its skeleton is hidden). A name the ready catalog does
// not know is "unknown"; a failed first snapshot is the screen's state, not
// the panel's (agentsFailed).
export function agentsDetail(name: string | undefined, found: boolean, stage: SnapshotStage): AgentsDetail {
  if (!name) {
    return 'pick';
  }

  if (found) {
    return 'agent';
  }

  return stage === 'ready' ? 'unknown' : 'loading';
}

export type AgentsShell = {
  title: string;
  titleNarrow?: string;
  back?: AppRoute;
  backNarrow?: boolean;
  detail: boolean;
};

// The shell: the catalog is the section; a selected agent keeps "Agents" as
// the wide title (the catalog stays beside the details) and becomes a
// detail screen on the phone — its name as the title, "back" to the
// catalog with the search kept, no tabs.
export function agentsShell(route: AgentsRoute): AgentsShell {
  if (!route.name) {
    return { title: 'Agents', detail: false };
  }

  return { title: 'Agents', titleNarrow: route.name, back: withAgentsFilters(route, { name: undefined }), backNarrow: true, detail: true };
}
