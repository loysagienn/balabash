// The rules of the project page: what the screen is (loading, failed, no
// such project, the project), the shell from the project and the path
// inside its folder, the routes of the file area rooted at the folder, the
// three pinned files from the folder's listing. Pure, tested.

import type { WorkspaceFileMeta } from '../../../api/contract.ts';
import type { AppRoute } from '../../lib/router/routes.ts';
import type { SnapshotStage } from '../../store/stream/selectors.ts';
import { crumbSegments, joinPath, nameOf, parentOf } from '../../features/file-area/node.ts';
import { fileTimeLabel } from '../../lib/format/index.ts';
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
// the root is the project page itself, below it /projects/<slug>/files/….
export function projectRoute(slug: string, absolutePath: string): AppRoute {
  const below = crumbSegments(slug, absolutePath).join('/');

  return below ? { key: 'project', slug, path: below } : { key: 'project', slug };
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
