// The words and rules of the Agents screen: the catalog search, the engine
// names, the mode of an agent, the summary of the filter bar, the shell of
// the split view (the selected agent is a detail screen on the phone, a
// panel beside the catalog when wide) and the next route of a filter
// change. Pure, tested.

import type { AgentView } from '../../../api/contract.ts';
import type { AgentsRoute, AppRoute } from '../../lib/router/routes.ts';
import { countOf } from '../../lib/format/index.ts';
import type { SnapshotStage } from '../../store/stream/selectors.ts';
import { RECENT_DAYS } from '../../features/thread-list/totals.ts';

// The search looks through the name and the description, case-insensitive.
export function agentMatches(agent: Pick<AgentView, 'name' | 'description'>, q: string | undefined): boolean {
  const needle = q?.trim().toLowerCase();

  if (!needle) {
    return true;
  }

  return agent.name.toLowerCase().includes(needle) || agent.description.toLowerCase().includes(needle);
}

// The model of a catalog row: the one the declaration names, else the one
// the agent's newest session ran on (what the engine's default resolved
// to), else the engine's choice, not yet seen.
export function catalogModel(agent: Pick<AgentView, 'model' | 'lastModel'>): string {
  return agent.model ?? agent.lastModel ?? 'default model';
}

// A setting of the details: the value (a model id, an effort) and a quiet
// note on where it comes from; no value — the note alone.
export type SettingWords = { value: string | null; note: string | null };

// The model row: a named model as it is, with a note when the newest
// session ran on another id (an alias resolved, a changed default); no
// named model — the engine's default as the newest session resolved it,
// or nothing seen yet.
export function modelWords(agent: Pick<AgentView, 'model' | 'lastModel'>): SettingWords {
  if (agent.model) {
    return { value: agent.model, note: agent.lastModel && agent.lastModel !== agent.model ? `last session ran ${agent.lastModel}` : null };
  }

  if (agent.lastModel) {
    return { value: agent.lastModel, note: 'default of the engine · last session' };
  }

  return { value: null, note: 'default of the engine' };
}

// The effort row: a named effort as it is; none — the platform's default
// the session runs with; an engine without one (the coordinator) — the
// model's own.
export function effortWords(agent: Pick<AgentView, 'effort' | 'defaultEffort'>): SettingWords {
  if (agent.effort) {
    return { value: agent.effort, note: null };
  }

  if (agent.defaultEffort) {
    return { value: agent.defaultEffort, note: 'default of the platform' };
  }

  return { value: null, note: 'default of the model' };
}

export function modeLabel(headless: boolean): string {
  return headless ? 'headless · no user surface' : 'with the user · not headless';
}

// "11 agents · 4 active threads" above the catalog.
export function agentsSummary(agents: number, running: number): string {
  return `${countOf(agents, 'agent')} · ${countOf(running, 'active thread')}`;
}

// "214 threads · 61 in 30 days · 2 running" over the activity: the whole
// count and the recent one come by place (features/thread-list/totals.ts),
// the running ones are the store's. Until the whole count is known only the
// running ones are named; a caption with nothing to say is none — the empty
// activity speaks for itself.
export function activityCaption(total: number | null, recent: number | null, running: number): string | undefined {
  const parts: string[] = [];

  if (total !== null && total > 0) {
    parts.push(countOf(total, 'thread'));

    if (recent !== null) {
      parts.push(`${recent.toLocaleString('en-US')} in ${RECENT_DAYS} days`);
    }
  }

  if (running > 0) {
    parts.push(`${running} running`);
  }

  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export type EmptyWords = { title: string; note: string };

// The empty activity. The store holds a window of threads — the newest ones
// and the active ones — so an agent with none in it may still have threads:
// "No threads yet" only when the whole count says none; otherwise the
// agent's threads are all older than the window, named with their count once
// it is known (the link below the activity leads to them). Before the count
// lands, or when it failed, the window's own truth is told without a number.
export function emptyActivity(name: string, total: number | null): EmptyWords {
  if (total === 0) {
    return { title: 'No threads yet', note: `Threads of ${name} appear here as it works.` };
  }

  return {
    title: 'No recent threads',
    note: total === null ? `Nothing recent from ${name}; its earlier threads are in the full list.` : `${name} has ${countOf(total, 'thread')}, all older than the recent ones shown here; the full list has them.`,
  };
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
