// The words and the order of the workspace switcher and of Settings' card
// "Signed in on this browser": the workspaces this browser is signed in to
// (GET /api/workspaces, in the order they were signed in to), each with its
// mark's color (this browser's choice, lib/workspace) — and while the list
// is not there (loading, failed, an older server), the tab's own workspace
// from `me` alone.

import type { LoginSource, MeResponse, WorkspacesResponse } from '../../../api/contract.ts';
import type { WorkspaceColors } from '../../lib/workspace/index.ts';

export type WorkspaceItem = {
  workspaceId: string;
  name: string;
  operator: string | null;
  color: number;
  current: boolean;
  signedInAt: Date | null;
  loginSource: LoginSource | null;
};

export const UNNAMED_WORKSPACE = 'Workspace';

export function workspaceName(name: string | null | undefined): string {
  return name?.trim() || UNNAMED_WORKSPACE;
}

export function workspaceIds(me: MeResponse | null, list: WorkspacesResponse | undefined): string[] {
  const ids = list ? list.workspaces.map(w => w.workspaceId) : [];

  return me && !ids.includes(me.workspaceId) ? [me.workspaceId, ...ids] : ids;
}

export function workspaceItems(me: MeResponse | null, list: WorkspacesResponse | undefined, colors: WorkspaceColors): WorkspaceItem[] {
  const current = me?.workspaceId ?? list?.current ?? null;
  const items: WorkspaceItem[] = (list?.workspaces ?? []).map(w => ({
    workspaceId: w.workspaceId,
    // The tab's own workspace speaks with `me`, which the tail keeps fresh.
    name: workspaceName(w.workspaceId === me?.workspaceId ? me.workspaceName : w.workspaceName),
    operator: w.workspaceId === me?.workspaceId ? me.operatorName : w.operatorName,
    color: colors[w.workspaceId] ?? 1,
    current: w.workspaceId === current,
    signedInAt: w.signedInAt,
    loginSource: w.loginSource,
  }));

  if (me && !items.some(item => item.workspaceId === me.workspaceId)) {
    items.unshift({ workspaceId: me.workspaceId, name: workspaceName(me.workspaceName), operator: me.operatorName, color: colors[me.workspaceId] ?? 1, current: true, signedInAt: null, loginSource: null });
  }

  return items;
}

// What the "Sign in to another workspace" window does with the workspace a
// code signed in to: the tab's own — nothing to switch to; one already in
// the list — a plain switch; a new one — a switch that says so, with the
// way back.
export type AddOutcome = { kind: 'same' } | { kind: 'switch'; workspaceId: string } | { kind: 'added'; workspaceId: string };

export function addOutcome(signedInTo: string, current: string | null, known: string[]): AddOutcome {
  if (signedInTo === current) {
    return { kind: 'same' };
  }

  return known.includes(signedInTo) ? { kind: 'switch', workspaceId: signedInTo } : { kind: 'added', workspaceId: signedInTo };
}
