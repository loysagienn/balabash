// Projects (design: ProjectsScreen): every project of the registry as a
// tile — name, description, when it was last worked on, the folder, how
// many threads are running; the active ones and the archive as segments,
// a search, "Create". The segment and the search are the route. Nothing
// is requested: the registry is the snapshot and its tail; creation is the
// dialog over CREATE_PROJECT.

import { useState } from 'react';
import type { ProjectsRoute } from '../../lib/router/routes.ts';
import { useLinkTargets } from '../../lib/router/Link.tsx';
import { agoLabel } from '../../lib/format/index.ts';
import { useNow } from '../../lib/format/useNow.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { snapshotLoad } from '../../store/stream/actions.ts';
import { selectStream, snapshotStage } from '../../store/stream/selectors.ts';
import { selectProjects } from '../../store/projects/selectors.ts';
import { selectRunningCountByProject } from '../../store/threads/selectors.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { NewProjectDialog } from '../../features/projects/NewProjectDialog.tsx';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Card } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { FBar } from '../../ui/FBar/FBar.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { List } from '../../ui/List/List.tsx';
import { ProjectTile, Tiles } from '../../ui/ProjectTile/ProjectTile.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { Seg, SegItem } from '../../ui/Seg/Seg.tsx';
import { SkelRow } from '../../ui/Skel/Skel.tsx';
import { matchesElsewhere, nothingFoundWords, projectsCounts, visibleProjects, withProjectsFilters } from './ProjectsScreen.logic.ts';

const SKELETON = [[55, 70], [40, 62], [48, 75]];

export function ProjectsScreen({ route }: { route: ProjectsRoute }) {
  const dispatch = useAppDispatch();
  const now = useNow();
  const linkTarget = useLinkTargets();
  const stream = useAppSelector(selectStream);
  const projects = useAppSelector(selectProjects);
  const runningByProject = useAppSelector(selectRunningCountByProject);
  // The "New project" dialog, with the name it starts from (the search that
  // found nothing).
  const [creating, setCreating] = useState<string | null>(null);
  const stage = snapshotStage(stream);
  const counts = projectsCounts(projects);
  const visible = visibleProjects(projects, route);
  const archived = Boolean(route.archived);
  const go = (patch: Parameters<typeof withProjectsFilters>[1]) => dispatch(routeTo(withProjectsFilters(route, patch), { replace: true }));

  let body;

  if (stage === 'loading') {
    body = (
      <Card narrow="bare">
        <List narrow="tiles" busy>
          {SKELETON.map((w, i) => (
            <SkelRow key={i} widths={w} />
          ))}
        </List>
      </Card>
    );
  } else if (stage === 'failed') {
    body = (
      <Card narrow="bare">
        <Empty icon="cloud-off" state="err" title="Couldn’t load the projects" action="Retry" actionIcon="refresh-cw" onAction={() => dispatch(snapshotLoad())}>
          {stream.snapshot.error?.message}
        </Empty>
      </Card>
    );
  } else if (visible.length > 0) {
    body = (
      <Tiles min="300px">
        {visible.map(project => (
          <ProjectTile
            key={project.id}
            title={project.title}
            desc={project.description || undefined}
            when={agoLabel(project.updatedAt, now)}
            slug={`${project.slug}/`}
            threads={runningByProject[project.id] ?? 0}
            archived={project.archived}
            {...linkTarget({ key: 'project', slug: project.slug })}
          />
        ))}
      </Tiles>
    );
  } else if (route.q) {
    body = (
      <Card narrow="bare">
        <Empty icon="search-x" title="Nothing found" action={archived ? 'Clear search' : `Create “${route.q}”`} actionIcon={archived ? undefined : 'plus'} onAction={() => (archived ? go({ q: undefined }) : setCreating(route.q ?? ''))}>
          {nothingFoundWords(route.q, archived, matchesElsewhere(projects, route))}
        </Empty>
      </Card>
    );
  } else if (archived) {
    body = (
      <Card narrow="bare">
        <Empty icon="archive" title="Nothing archived">
          An archived project keeps its files and threads; agents don’t pick it up.
        </Empty>
      </Card>
    );
  } else {
    body = (
      <Card narrow="bare">
        <Empty icon="folder" title="No projects yet" action="Create a project" actionIcon="plus" onAction={() => setCreating('')}>
          A project is a folder with AGENTS.md — a long-lived context agents read first. Create one here or ask an agent to start it.
        </Empty>
      </Card>
    );
  }

  return (
    <Shell current="projects" title="Projects">
      <Screen>
        <FBar
          filters={
            <Seg label="Projects">
              <SegItem label="Active" n={stage === 'ready' ? counts.active : undefined} sel={!archived} onClick={() => go({ archived: false })} />
              <SegItem label="Archive" n={stage === 'ready' ? counts.archived : undefined} sel={archived} onClick={() => go({ archived: true })} />
            </Seg>
          }
          search={
            <>
              <Input
                value={route.q ?? ''}
                onChange={q => go({ q })}
                placeholder="Search projects"
                lead="search"
                ariaLabel="Search projects"
                end={route.q ? <IconBtn icon="x" label="Clear" size="sm" onClick={() => go({ q: undefined })} /> : undefined}
              />
              <Btn label="Create" icon="plus" variant="primary" onClick={() => setCreating('')} />
            </>
          }
        />
        {body}
        {creating !== null ? <NewProjectDialog initialTitle={creating} onClose={() => setCreating(null)} /> : null}
      </Screen>
    </Shell>
  );
}
