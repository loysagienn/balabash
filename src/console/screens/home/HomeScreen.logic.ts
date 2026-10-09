// The words of the Home screen, computed from the store's domains: the
// summary under each section link, the note of the empty "Active threads"
// card, the chip text of a published app. Pure, tested.

import type { NavKey } from '../../lib/router/routes.ts';
import { agoLabel, countOf, plural, shortDate, timeOfDay } from '../../lib/format/index.ts';

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
  now: Date;
};

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// The summary of a section on Home — only from what the snapshot carries:
// Files (count and size), System (telemetry) and Settings have no summary
// until their data exists (plan.md, "Чего нет в данных"); a section without
// a summary is drawn without one.
export function sectionSummary(key: NavKey, counts: SectionCounts): SectionSummary | null {
  switch (key) {
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

// The chip text of a published app: its address without the scheme.
export function appUrlText(href: string): string {
  return href.replace(/^https?:\/\//, '');
}

// Where a row of the Apps card leads. A published app has an address
// (publicAppsBase + slug) — the chip shows it, and the row opens it in a
// new tab while the manifest is valid; a broken manifest keeps the address
// (the publication stands) but answers 503 there, so the row, like one of
// an unpublished app, leads to the Apps section instead (href null).
export function homeAppLink(app: { slug: string | null; manifestError: string | null }, base: string): { address: string | null; href: string | null } {
  const address = app.slug ? `${base}/${encodeURIComponent(app.slug)}` : null;

  return { address, href: address !== null && app.manifestError === null ? address : null };
}

// The stage of the overview: the first snapshot in flight, failed before
// any landed, or the data on screen.
export function homeStage(stream: { asOfSeq: bigint | null; snapshot: { pending: boolean; error: { message: string } | null } }): 'loading' | 'failed' | 'ready' {
  if (stream.asOfSeq !== null) {
    return 'ready';
  }

  return stream.snapshot.error && !stream.snapshot.pending ? 'failed' : 'loading';
}
