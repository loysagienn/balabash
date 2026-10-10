// The filter bar of the Threads screen: status segments, agent, project and
// period pickers, search — all of it is the route (frontend.md: filters live
// in the URL, a change replaces the history entry), and every one of them
// reloads the list from the server. The segments carry the counts of the
// set (segmentCount). "/" focuses the search from anywhere on the screen.

import { useEffect, useState } from 'react';
import type { ThreadCounts, ThreadStatus } from '../../../core/contract.ts';
import type { ThreadsRoute } from '../../lib/router/routes.ts';
import { useNow } from '../../lib/format/useNow.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { selectProjects } from '../../store/projects/selectors.ts';
import { routeTo } from '../../store/router/actions.ts';
import { selectKnownAgents } from '../../store/threads/selectors.ts';
import { segmentCount } from './counts.ts';
import { FBar } from '../../ui/FBar/FBar.tsx';
import { FChip } from '../../ui/FChip/FChip.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { Menu, MenuAnchor, MenuItem, MenuSep } from '../../ui/Menu/Menu.tsx';
import { Seg, SegItem } from '../../ui/Seg/Seg.tsx';
import { Kbd } from '../../ui/atoms/atoms.tsx';
import { withFilters } from './filters.ts';
import type { ThreadsFilterPatch } from './filters.ts';
import { PERIOD_PRESETS, periodLabel, periodPreset, presetPeriod } from './period.ts';

const SEARCH_ID = 'threads-search';

// "All" (no status filter, the default of the route) opens the row — Vladimir's 29156.
export const STATUS_SEGMENTS: { label: string; status: ThreadStatus | undefined }[] = [
  { label: 'All', status: undefined },
  { label: 'Active', status: 'active' },
  { label: 'Completed', status: 'completed' },
  { label: 'Crashed', status: 'failed' },
  { label: 'Cancelled', status: 'cancelled' },
];

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.closest('input, textarea, select, [contenteditable]') !== null);
}

export type ThreadFiltersProps = {
  route: ThreadsRoute;
  // The counts of the current set and the store's number of active threads in it.
  counts: ThreadCounts | null;
  active: number;
};

export function ThreadFilters({ route, counts, active }: ThreadFiltersProps) {
  const dispatch = useAppDispatch();
  const agents = useAppSelector(selectKnownAgents);
  const projects = useAppSelector(selectProjects);
  const project = route.project ? projects.find(p => p.slug === route.project) : undefined;
  const now = useNow();
  const period = periodLabel(route, now);
  const preset = periodPreset(route, now);
  const [menu, setMenu] = useState<'agent' | 'project' | 'period' | null>(null);
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
                n={segmentCount(segment.status, counts, active)}
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
          <MenuAnchor
            open={menu === 'period'}
            onClose={() => setMenu(null)}
            menu={
              <Menu label="Period">
                <MenuItem icon="circle-dashed" label="Any time" checked={!period} onClick={() => (setMenu(null), go({ from: undefined, to: undefined }))} />
                <MenuSep />
                {PERIOD_PRESETS.map(p => (
                  <MenuItem key={p.id} icon="calendar" label={p.label} checked={preset === p.id} onClick={() => (setMenu(null), go({ from: undefined, to: undefined, ...presetPeriod(p.id, now) }))} />
                ))}
              </Menu>
            }
          >
            <FChip label="Period" value={period} icon="calendar" end="chevron-down" expanded={menu === 'period'} onClick={() => setMenu(menu === 'period' ? null : 'period')} />
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
