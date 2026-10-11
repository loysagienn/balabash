// The workspaces of this browser (GET /api/workspaces) — the second data
// layer: the names of the other workspaces are not in the log of the one the
// tab shows. Read when the switcher or Settings is on screen; the tab's own
// name follows `me` (workspaces.logic.ts). The marks' colors are this
// browser's (lib/workspace), followed across tabs.

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/api/context.tsx';
import { retryUnlessClient } from '../../lib/api/retry.ts';
import { assignColors, colorsSnapshot, readColors, subscribeColors, workspaceColors } from '../../lib/workspace/index.ts';
import type { WorkspaceColors } from '../../lib/workspace/index.ts';
import { useAppSelector } from '../../store/hooks.ts';
import { selectMe } from '../../store/session/selectors.ts';
import { workspaceIds, workspaceItems } from './workspaces.logic.ts';
import type { WorkspaceItem } from './workspaces.logic.ts';

export const WORKSPACES_KEY = ['workspaces'] as const;
const WORKSPACES_FRESH_MS = 30_000;

export function useWorkspacesQuery() {
  const api = useApi();

  return useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: ({ signal }) => api.workspaces.list(signal),
    retry: retryUnlessClient,
    staleTime: WORKSPACES_FRESH_MS,
  });
}

// The colors of the marks of `ids`: the stored ones, the first free color for
// a workspace without one (stored once assigned).
export function useWorkspaceColors(ids: string[]): WorkspaceColors {
  const snapshot = useSyncExternalStore(subscribeColors, colorsSnapshot, () => '');
  const key = ids.join(',');
  // `snapshot` changes when a color is stored (here or in another tab).
  const { colors, assigned } = useMemo(() => assignColors(ids, readColors()), [key, snapshot]);

  useEffect(() => {
    if (assigned) {
      workspaceColors(ids);
    }
  }, [assigned, key]);

  return colors;
}

export type Workspaces = {
  items: WorkspaceItem[];
  current: WorkspaceItem | null;
  // The list is the server's (not the tab's own workspace alone).
  listed: boolean;
};

export function useWorkspaces(): Workspaces {
  const me = useAppSelector(selectMe);
  const query = useWorkspacesQuery();
  const ids = workspaceIds(me, query.data);
  const colors = useWorkspaceColors(ids);
  const items = workspaceItems(me, query.data, colors);

  return { items, current: items.find(item => item.current) ?? null, listed: query.data !== undefined };
}
