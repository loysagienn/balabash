// The filter bar of the Threads screen: status segments, agent and project
// pickers, search — all of it is the route (frontend.md: filters live in
// the URL, a change replaces the history entry). Status and project reload
// the list from the server; agent and search narrow the loaded rows in the
// browser. "/" focuses the search from anywhere on the screen.

import { useEffect, useState } from 'react';
import type { ThreadStatus } from '../../../core/contract.ts';
import type { ThreadsRoute } from '../../lib/router/routes.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { selectProjects } from '../../store/projects/selectors.ts';
import { routeTo } from '../../store/router/actions.ts';
import { selectKnownAgents, selectThreadsById } from '../../store/threads/selectors.ts';
import { FBar } from '../../ui/FBar/FBar.tsx';
import { FChip } from '../../ui/FChip/FChip.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { Menu, MenuAnchor, MenuItem, MenuSep } from '../../ui/Menu/Menu.tsx';
import { Seg, SegItem } from '../../ui/Seg/Seg.tsx';
import { Kbd } from '../../ui/atoms/atoms.tsx';
import { withFilters } from './filters.ts';
import type { ThreadsFilterPatch } from './filters.ts';

const SEARCH_ID = 'threads-search';

export const STATUS_SEGMENTS: { label: string; status: ThreadStatus | undefined }[] = [
  { label: 'Active', status: 'active' },
  { label: 'Completed', status: 'completed' },
  { label: 'Crashed', status: 'failed' },
  { label: 'Cancelled', status: 'cancelled' },
  { label: 'All', status: undefined },
];

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.closest('input, textarea, select, [contenteditable]') !== null);
}

export function ThreadFilters({ route }: { route: ThreadsRoute }) {
  const dispatch = useAppDispatch();
  const agents = useAppSelector(selectKnownAgents);
  const projects = useAppSelector(selectProjects);
  const project = route.project ? projects.find(p => p.slug === route.project) : undefined;
  const activeCount = useAppSelector(s => {
    const byId = selectThreadsById(s);

    return Object.values(byId).filter(t => t.status === 'active' && (!project || t.projectId === project.id) && (!route.agent || t.agent === route.agent)).length;
  });
  const [menu, setMenu] = useState<'agent' | 'project' | null>(null);
  const go = (patch: ThreadsFilterPatch) => dispatch(routeTo(withFilters(route, patch), { replace: true }));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !isTyping(event.target)) {
        event.preventDefault();
        document.getElementById(SEARCH_ID)?.focus();
      }
    };

    document.addEventListener('keydown', onKey);

    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const pickable = projects.filter(p => !p.archived || p.id === project?.id);

  return (
    <FBar
      filters={
        <>
          <Seg label="Status">
            {STATUS_SEGMENTS.map(segment => (
              <SegItem
                key={segment.label}
                label={segment.label}
                n={segment.status === 'active' ? activeCount : undefined}
                sel={route.status === segment.status}
                onClick={() => go({ status: segment.status })}
              />
            ))}
          </Seg>
          <MenuAnchor
            open={menu === 'agent'}
            onClose={() => setMenu(null)}
            menu={
              <Menu label="Agent">
                <MenuItem icon="circle-dashed" label="Any agent" checked={!route.agent} onClick={() => (setMenu(null), go({ agent: undefined }))} />
                <MenuSep />
                {agents.map(agent => (
                  <MenuItem key={agent} icon="bot" label={agent} checked={route.agent === agent} onClick={() => (setMenu(null), go({ agent }))} />
                ))}
              </Menu>
            }
          >
            <FChip label="Agent" value={route.agent} icon="bot" end="chevron-down" expanded={menu === 'agent'} onClick={() => setMenu(menu === 'agent' ? null : 'agent')} />
          </MenuAnchor>
          <MenuAnchor
            open={menu === 'project'}
            onClose={() => setMenu(null)}
            menu={
              <Menu label="Project">
                <MenuItem icon="circle-dashed" label="Any project" checked={!route.project} onClick={() => (setMenu(null), go({ project: undefined }))} />
                <MenuSep />
                {pickable.map(p => (
                  <MenuItem key={p.id} icon="folder" label={p.title} checked={route.project === p.slug} onClick={() => (setMenu(null), go({ project: p.slug }))} />
                ))}
              </Menu>
            }
          >
            <FChip
              label="Project"
              value={route.project ? (project?.title ?? route.project) : undefined}
              icon="folder"
              end="chevron-down"
              expanded={menu === 'project'}
              onClick={() => setMenu(menu === 'project' ? null : 'project')}
            />
          </MenuAnchor>
        </>
      }
      search={
        <Input
          id={SEARCH_ID}
          value={route.q ?? ''}
          onChange={q => go({ q })}
          placeholder="Search titles and summaries"
          lead="search"
          ariaLabel="Search threads"
          end={route.q ? <IconBtn icon="x" label="Clear" size="sm" onClick={() => go({ q: undefined })} /> : <Kbd>/</Kbd>}
        />
      }
    />
  );
}
