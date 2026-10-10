// Project (design: ProjectScreen): the header — name, description, folder,
// dates, "Edit" and "Archive" (or "Unarchive") — the project's threads the
// store knows under the link to all of them with their whole count (read
// by place: features/thread-list/queries.ts), and the whole file area rooted at the project folder with
// AGENTS.md / inbox.md / journal.md pinned above the rows (design rule 17;
// the same FileBrowser as Files). The project is the registry row by the
// route's slug; the path inside the folder is the route too. Editing is
// the dialog over UPDATE_PROJECT; archiving flips the flag at once
// (reversible — no confirmation, rule 13 is for the irreversible).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectView } from '../../../api/contract.ts';
import type { ProjectRoute } from '../../lib/router/routes.ts';
import { Link, useLinkTargets } from '../../lib/router/Link.tsx';
import { agoLabel, shortDate } from '../../lib/format/index.ts';
import { useNow } from '../../lib/format/useNow.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { snapshotLoad } from '../../store/stream/actions.ts';
import { selectStream, snapshotStage } from '../../store/stream/selectors.ts';
import { setProjectArchived } from '../../store/projects/actions.ts';
import { selectProjectBySlug, selectProjectFlagging } from '../../store/projects/selectors.ts';
import { makeSelectProjectThreads, selectRunningCountByProject } from '../../store/threads/selectors.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { FileBrowser } from '../../features/file-area/FileBrowser.tsx';
import { joinPath, nodeOf } from '../../features/file-area/node.ts';
import { useWorkspaceNode } from '../../features/file-area/queries.ts';
import { EditProjectDialog } from '../../features/projects/EditProjectDialog.tsx';
import { ThreadList } from '../../features/thread-list/ThreadList.tsx';
import { useThreadTotal } from '../../features/thread-list/queries.ts';
import { TotalFailure } from '../../features/thread-list/TotalFailure.tsx';
import { knownTotal } from '../../features/thread-list/totals.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Card, CardHead } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { PageHead } from '../../ui/PageHead/PageHead.tsx';
import { Pin, Pins } from '../../ui/Pins/Pins.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { Skel, SkelStack } from '../../ui/Skel/Skel.tsx';
import { allThreadsLabel, emptyProjectThreads, pinsOf, projectRoute, projectShell, projectStage } from './ProjectScreen.logic.ts';
import './ProjectScreen.css';

// The card shows the newest threads; the rest are a link away.
const PROJECT_THREADS = 8;

function ProjectPins({ project, now }: { project: ProjectView; now: Date }) {
  // The folder's own listing — the same query the file area runs at the
  // root, so no second request there.
  const root = useWorkspaceNode(project.slug);
  const listing = nodeOf(root);
  const linkTarget = useLinkTargets();
  const pins = listing?.kind === 'dir' ? pinsOf(project.slug, listing.files, now) : [];

  if (pins.length === 0) {
    return null;
  }

  return (
    <Pins>
      {pins.map(pin => (
        <Pin key={pin.name} icon={pin.icon} name={pin.name} desc={pin.desc} {...linkTarget(projectRoute(project.slug, pin.path))} />
      ))}
    </Pins>
  );
}

function ProjectPage({ project, route }: { project: ProjectView; route: ProjectRoute }) {
  const dispatch = useAppDispatch();
  const now = useNow();
  const selectThreads = useMemo(makeSelectProjectThreads, []);
  const threads = useAppSelector(s => selectThreads(s, project.id));
  const running = useAppSelector(selectRunningCountByProject)[project.id] ?? 0;
  // The project's whole count of threads from the server, brought up to
  // the tail the store has folded since; a failed request has no number,
  // whatever Query kept, and is named beside the link with its Retry (the
  // link stays — "All" is a route either way).
  const all = useThreadTotal({ projectId: project.id });
  const total = knownTotal(all, threads);
  // An empty card says whether the project has no threads or none recent.
  const empty = emptyProjectThreads(total);
  const flagging = useAppSelector(s => selectProjectFlagging(s, project.id));
  const [editing, setEditing] = useState(false);
  const path = joinPath(project.slug, route.path ?? '');
  const files = useRef<HTMLElement>(null);
  const acts = useRef<HTMLSpanElement>(null);

  // A move inside the folder keeps the body's scroll place (Shell); when
  // the file card is then out of view — its head scrolled past above, or
  // still below — it comes to the top, so the rows or the opened file are
  // where the eye is, not the project header. Not on the first render:
  // a page opened at a path starts at the top as any screen.
  const firstPath = useRef(true);

  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }

    const card = files.current;
    const box = card?.closest('.shell-body');

    if (!card || !box) {
      return;
    }

    const top = card.getBoundingClientRect().top;
    const view = box.getBoundingClientRect();

    if (top < view.top || top > view.bottom - 1) {
      card.scrollIntoView({ block: 'start' });
    }
  }, [route.path]);

  // Archive / Unarchive replace the button that held the focus; a keyboard
  // user keeps their place — the focus moves to the action that took it.
  const firstFlag = useRef(true);

  useEffect(() => {
    if (firstFlag.current) {
      firstFlag.current = false;
      return;
    }

    if (document.activeElement === document.body || document.activeElement === null) {
      acts.current?.querySelector('button')?.focus();
    }
  }, [project.archived]);

  return (
    <>
      {project.archived ? (
        <Note state="off" icon="archive">
          Archived. Agents don’t pick it up; files and threads stay available.
        </Note>
      ) : null}
      <PageHead
        title={project.title}
        desc={project.description || undefined}
        slug={`${project.slug}/`}
        created={`created ${shortDate(project.createdAt, now)}`}
        work={`last worked ${agoLabel(project.updatedAt, now)}`}
        archived={project.archived}
      >
        <span ref={acts} className="proj-acts">
          {project.archived ? (
            <Btn label="Unarchive" icon="archive-restore" busy={flagging} onClick={() => dispatch(setProjectArchived(project.id, false))} />
          ) : (
            <>
              <Btn label="Edit" icon="pencil" onClick={() => setEditing(true)} />
              <Btn label="Archive" icon="archive" variant="ghost" busy={flagging} onClick={() => dispatch(setProjectArchived(project.id, true))} />
            </>
          )}
        </span>
      </PageHead>
      <Card narrow="bare">
        <CardHead
          title="Project threads"
          count={running > 0 ? running : undefined}
          countState="run"
          link={
            <Link className="link" route={{ key: 'threads', project: project.slug }}>
              {allThreadsLabel(total)}
            </Link>
          }
        >
          <TotalFailure queries={[all]} />
        </CardHead>
        {threads.length > 0 ? (
          <ThreadList threads={threads.slice(0, PROJECT_THREADS)} now={now} flat />
        ) : (
          <Empty icon="messages-square" title={empty.title}>
            {empty.note}
          </Empty>
        )}
      </Card>
      <Card narrow="bare" ref={files}>
        <CardHead title="Project files" />
        <div className="proj-fa-wrap">
          <FileBrowser root={project.slug} rootLabel={project.title} lead="folder" path={path} routeFor={absolute => projectRoute(project.slug, absolute)} pins={<ProjectPins project={project} now={now} />} className="proj-fa" />
        </div>
      </Card>
      {editing ? <EditProjectDialog project={project} onClose={() => setEditing(false)} /> : null}
    </>
  );
}

export function ProjectScreen({ route }: { route: ProjectRoute }) {
  const dispatch = useAppDispatch();
  const stream = useAppSelector(selectStream);
  const project = useAppSelector(s => selectProjectBySlug(s, route.slug)) ?? null;
  const stage = projectStage(project !== null, snapshotStage(stream));
  // What the path inside the folder names (a folder or a file) — the shell
  // changes with it; the file area runs the same query.
  const node = useWorkspaceNode(joinPath(route.slug, route.path ?? ''), stage === 'project' && Boolean(route.path));
  const kind = route.path ? (nodeOf(node)?.kind ?? null) : null;
  const shell = projectShell(project?.title ?? route.slug, route.slug, route.path, kind);

  let body;

  if (stage === 'project' && project) {
    body = <ProjectPage key={project.id} project={project} route={route} />;
  } else if (stage === 'unknown') {
    body = (
      <Card narrow="bare">
        <Empty icon="folder" title={`No project named “${route.slug}”`} action="All projects" onAction={() => dispatch(routeTo({ key: 'projects' }))}>
          It is not in the registry; its folder, if any, is under Files.
        </Empty>
      </Card>
    );
  } else if (stage === 'failed') {
    body = (
      <Card narrow="bare">
        <Empty icon="cloud-off" state="err" title="Couldn’t load the project" action="Retry" actionIcon="refresh-cw" onAction={() => dispatch(snapshotLoad())}>
          {stream.snapshot.error?.message}
        </Empty>
      </Card>
    );
  } else {
    body = (
      <Card narrow="bare" label="Loading the project">
        <div className="phead" aria-hidden="true">
          <div className="phead-main">
            <SkelStack widths={[32, 70, 40]} />
          </div>
          <Skel shape="pill" />
        </div>
      </Card>
    );
  }

  return (
    <Shell current="projects" title={shell.title} titleNarrow={shell.titleNarrow} crumb={shell.crumb} back={shell.back} detail={shell.detail} pageHead={stage === 'project' && shell.pageHead}>
      <Screen>{body}</Screen>
    </Shell>
  );
}
