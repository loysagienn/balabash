// The words of the Home screen, computed from the store's domains: the
// summary under each section link, the note of the empty "Active threads"
// card, the banner of a tail that is not flowing. Pure, tested. Where an app row leads — lib/apps/appLink.ts,
// the stage of the screen — snapshotStage (store/stream): both shared with
// the Apps section.

import type { SystemResponse } from '../../../api/contract.ts';
import type { NavKey } from '../../lib/router/routes.ts';
import { agoLabel, countOf, dateTimeLabel, plural, shortDate, timeOfDay } from '../../lib/format/index.ts';
import { fileAreaSummary, systemSummary } from '../system/facts.logic.ts';

export type SectionSummary = { meta: string; state?: 'act' };

export type SectionCounts = {
  running: number;
  projects: number;
  archivedProjects: number;
  apps: number;
  publishedApps: number;
  tasks: number;
  // The nearest next run among the tasks, if any has a trigger.
  nextRunAt: Date | null;
  connections: number;
  connectionsNeedingAction: number;
  agents: number;
  // The facts read by place (GET /api/system): the file area's totals and
  // the machine; null until the server answered.
  facts: Pick<SystemResponse, 'machine' | 'fileArea'> | null;
  now: Date;
};

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// The summary of a section on Home — from what the snapshot carries, and
// for Files and System from the facts read by place (the file area's
// totals, the machine); Settings names what it holds. A section without a
// summary yet is drawn without one.
export function sectionSummary(key: NavKey, counts: SectionCounts): SectionSummary | null {
  switch (key) {
    case 'files': {
      const meta = fileAreaSummary(counts.facts?.fileArea ?? null);

      return meta === null ? null : { meta };
    }
    case 'system': {
      const meta = systemSummary(counts.facts);

      return meta === null ? null : { meta };
    }
    case 'settings':
      return { meta: 'names, Telegram, time zone' };
    case 'threads':
      return { meta: `${counts.running} active` };
    case 'projects':
      if (counts.projects === 0) {
        return { meta: 'none yet' };
      }

      return { meta: `${counts.projects - counts.archivedProjects} active${counts.archivedProjects > 0 ? ` · ${counts.archivedProjects} archived` : ''}` };
    case 'apps':
      return { meta: counts.apps === 0 ? 'none yet' : `${counts.apps} · ${counts.publishedApps} published` };
    case 'schedule': {
      if (counts.tasks === 0) {
        return { meta: 'no tasks' };
      }

      const next = counts.nextRunAt;
      const when = next === null ? '' : sameDay(next, counts.now) ? ` · next at ${timeOfDay(next)}` : ` · next ${shortDate(next, counts.now)}, ${timeOfDay(next)}`;

      return { meta: `${countOf(counts.tasks, 'task')}${when}` };
    }
    case 'connections':
      if (counts.connectionsNeedingAction > 0) {
        return { meta: `${counts.connectionsNeedingAction} ${plural(counts.connectionsNeedingAction, 'needs', 'need')} sign-in`, state: 'act' };
      }

      return { meta: counts.connections === 0 ? 'none yet' : countOf(counts.connections, 'account') };
    case 'agents':
      return { meta: countOf(counts.agents, 'agent') };
    default:
      return null;
  }
}

// The explanation under "Nothing is running": when the last thread ended
// and what it was; before any has — what the card is for.
export function nothingRunningNote(last: { title: string | null; agent: string; updatedAt: Date } | null, now: Date): string {
  if (last === null) {
    return 'Threads appear here as agents start working.';
  }

  return `The last thread finished ${agoLabel(last.updatedAt, now)} — “${last.title ?? last.agent}”.`;
}

// The banner while the tail is not flowing (design: "No connection to the
// server. Data as of 16:31, reconnecting…"): the moment the screen is known
// current up to (stream.dataAt — the time of the break, with the date once
// it is another day), or no moment when the tail never opened.
export function offlineNote(dataAt: Date | null, now: Date): string {
  return dataAt ? `No connection to the server. Data as of ${dateTimeLabel(dataAt, now)}, reconnecting…` : 'No connection to the server. The data on screen may be behind; reconnecting…';
}
