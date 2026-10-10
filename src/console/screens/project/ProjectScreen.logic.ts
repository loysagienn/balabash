// The rules of the project page: what the screen is (loading, failed, no
// such project, the project), the shell from the project and the path
// inside its folder, the routes of the file area rooted at the folder, the
// three pinned files from the folder's listing. Pure, tested.

import type { WorkspaceFileMeta } from '../../../api/contract.ts';
import type { AppRoute } from '../../lib/router/routes.ts';
import type { SnapshotStage } from '../../store/stream/selectors.ts';
import { crumbSegments, joinPath, nameOf, parentOf } from '../../features/file-area/node.ts';
import { countOf, fileTimeLabel, shortDate } from '../../lib/format/index.ts';
import type { IconName } from '../../ui/Icon/Icon.tsx';

export type ProjectStage = 'loading' | 'failed' | 'unknown' | 'project';

// Before the first snapshot the slug cannot be looked up: the page shows a
// skeleton; a failed first snapshot is the page's own error; a slug the
// ready registry has no row for is "no such project".
export function projectStage(found: boolean, stage: SnapshotStage): ProjectStage {
  if (stage === 'ready') {
    return found ? 'project' : 'unknown';
  }

  return stage;
}

// The route of a path of the file area rooted at the project's folder:
// the root is the project page itself, below it /projects/<slug>/files/…;
// view — the editor over the file at the path.
export function projectRoute(slug: string, absolutePath: string, view?: 'edit'): AppRoute {
  const below = crumbSegments(slug, absolutePath).join('/');

  if (!below) {
    return { key: 'project', slug };
  }

  return view ? { key: 'project', slug, path: below, view } : { key: 'project', slug, path: below };
}

export type ProjectShell = {
  title: string;
  titleNarrow?: string;
  crumb: { label: string; route: AppRoute };
  back: AppRoute;
  detail: boolean;
  pageHead: boolean;
};

const PROJECTS_CRUMB = { label: 'Projects', route: { key: 'projects' } as AppRoute };

// The page's shell: the project's title with "Projects" above it and
// "back" to the list; its own header (PageHead) names the page on wide
// screens. Inside the folder "back" climbs the folder; a file is a detail
// screen on the phone, titled by its name there (the preview header names
// it on wide screens).
export function projectShell(title: string, slug: string, path: string | undefined, kind: 'dir' | 'file' | null): ProjectShell {
  if (!path) {
    return { title, crumb: PROJECTS_CRUMB, back: { key: 'projects' }, detail: false, pageHead: true };
  }

  const parent = parentOf(path);
  const back = projectRoute(slug, joinPath(slug, parent));

  if (kind === 'file') {
    return { title, titleNarrow: nameOf(path), crumb: PROJECTS_CRUMB, back, detail: true, pageHead: true };
  }

  return { title, titleNarrow: nameOf(path), crumb: PROJECTS_CRUMB, back, detail: false, pageHead: true };
}

// The link of the "Project threads" card: "All · 23" once the project's
// whole count is known (features/thread-list/totals.ts), "All" before —
// the way Home names all projects.
export function allThreadsLabel(total: number | null): string {
  return total === null ? 'All' : `All · ${total.toLocaleString('en-US')}`;
}

export type EmptyWords = { title: string; note: string };

// The empty "Project threads" card. The store holds a window of threads —
// the newest ones and the active ones — so a project with none in it may
// still have threads: "No threads yet" only when the whole count says none;
// otherwise the project's threads are all older than the window, named with
// their count once it is known ("All · N" in the card's header leads to
// them). Before the count lands, or when it failed, the window's own truth
// is told without a number.
export function emptyProjectThreads(total: number | null): EmptyWords {
  if (total === 0) {
    return { title: 'No threads yet', note: 'Threads started for this project appear here as agents work on it.' };
  }

  return {
    title: 'No recent threads',
    note: total === null ? 'Nothing recent for this project; its earlier threads are under All.' : `The project has ${countOf(total, 'thread')}, all older than the recent ones shown here; they are under All.`,
  };
}

// The note over an archived project: since when, where the date is known
// ("Archived since May 12."); a project archived before the date was kept
// reads "Archived." alone.
export function archivedNote(archivedAt: Date | null | undefined, now: Date): string {
  const since = archivedAt ? `Archived since ${shortDate(archivedAt, now)}.` : 'Archived.';

  return `${since} Agents don’t pick it up; files and threads stay available.`;
}

export type PinData = { icon: IconName; name: string; desc: string; path: string };

const PINS: { name: string; icon: IconName; role: string }[] = [
  { name: 'AGENTS.md', icon: 'pin', role: 'entry' },
  { name: 'inbox.md', icon: 'inbox', role: 'inbox' },
  { name: 'journal.md', icon: 'history', role: 'journal' },
];

// The project's main files pinned above the rows — those the folder's
// listing has (a seeded project has all three; an adopted folder may lack
// some): "entry · updated yesterday".
export function pinsOf(slug: string, files: Pick<WorkspaceFileMeta, 'path' | 'modifiedAt'>[], now: Date): PinData[] {
  const pins: PinData[] = [];

  for (const pin of PINS) {
    const path = joinPath(slug, pin.name);
    const file = files.find(candidate => candidate.path === path);

    if (file) {
      pins.push({ icon: pin.icon, name: pin.name, desc: file.modifiedAt ? `${pin.role} · updated ${fileTimeLabel(new Date(file.modifiedAt), now)}` : pin.role, path });
    }
  }

  return pins;
}
