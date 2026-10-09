// The rules of the Projects screen: the counts of the segments, the tiles
// under the route's segment and search (the most recently worked on first),
// the next route of a filter change, the words of an empty search. Pure,
// tested.

import type { ProjectView } from '../../../api/contract.ts';
import type { ProjectsRoute } from '../../lib/router/routes.ts';
import { projectMatches } from '../../features/projects/projectForm.logic.ts';

export type ProjectsCounts = { active: number; archived: number };

export function projectsCounts(projects: Pick<ProjectView, 'archived'>[]): ProjectsCounts {
  const archived = projects.filter(project => project.archived).length;

  return { active: projects.length - archived, archived };
}

type Tile = Pick<ProjectView, 'title' | 'slug' | 'description' | 'archived' | 'updatedAt'>;

export function visibleProjects<P extends Tile>(projects: P[], route: ProjectsRoute): P[] {
  return projects.filter(project => project.archived === Boolean(route.archived) && projectMatches(project, route.q)).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

// How many the search would find in the other segment — the empty state
// says where the matches are.
export function matchesElsewhere(projects: Tile[], route: ProjectsRoute): number {
  return projects.filter(project => project.archived !== Boolean(route.archived) && projectMatches(project, route.q)).length;
}

export type ProjectsFilterPatch = Partial<Omit<ProjectsRoute, 'key'>>;

// The next route of a change: an undefined, false or empty value drops the
// key, so the URL stays canonical.
export function withProjectsFilters(route: ProjectsRoute, patch: ProjectsFilterPatch): ProjectsRoute {
  const next: ProjectsRoute = { ...route, ...patch };

  if (!next.archived) delete next.archived;
  if (!next.q) delete next.q;

  return next;
}

// "No projects with “yacht” in the name, folder or description. None in
// the archive either." / "… 2 in the archive."
export function nothingFoundWords(q: string, archived: boolean, elsewhere: number): string {
  const where = archived ? 'among the active projects' : 'in the archive';
  const tail = elsewhere > 0 ? `${elsewhere} ${where}.` : `None ${where} either.`;

  return `No ${archived ? 'archived ' : ''}projects with “${q}” in the name, folder or description. ${tail}`;
}
