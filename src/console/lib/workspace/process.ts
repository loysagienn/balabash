// The workspace process: the store's session against the tab's workspace
// (lib/workspace). The workspace /api/me (or a sign-in) answered becomes the
// tab's — and the browser's last one while the tab is in front, and again
// whenever the user comes back to the tab. The page that follows a switch
// says what happened (the flash the previous page left): signed in to one
// more workspace, with the way back, or signed out of the one it showed.
// Signing out of the tab's workspace while others stay signed in
// (session.leaving) loads Home of the last one the user was in, else of the
// first; signing out of the last one leaves the tab with none.

import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';
import { pushToast } from '../../store/ui/actions.ts';
import { confirmWorkspace, forgetWorkspace, lastWorkspace, leaveSignedOutWorkspace, nextAfterSignOut, rememberLastWorkspace, switchWorkspace, takeFlash } from './index.ts';
import type { WorkspaceFlash } from './index.ts';

export function flashToast(flash: WorkspaceFlash, workspaceName: string | null): Parameters<typeof pushToast>[0] {
  const here = workspaceName ?? 'this workspace';

  if (flash.kind === 'signed-in') {
    return {
      title: `Signed in to ${here}`,
      state: 'done',
      ...(flash.back ? { action: { label: `Back to ${flash.back.name}`, workspace: flash.back.workspaceId } } : {}),
    };
  }

  return { title: `Signed out of ${flash.name}`, desc: `You’re in ${here} now.`, state: 'done' };
}

export function connectStoreToWorkspace(store: Store<State, Action>): () => void {
  let flash = takeFlash();
  let confirmed: string | null = null;
  let leaving = false;

  const unsubscribe = store.subscribe(() => {
    const { session } = store.getState();
    const workspaceId = session.me?.workspaceId ?? null;

    if (workspaceId && workspaceId !== confirmed) {
      confirmed = workspaceId;
      confirmWorkspace(workspaceId);

      if (flash) {
        const toast = flashToast(flash, session.me?.workspaceName ?? null);

        flash = null;
        store.dispatch(pushToast(toast));
      }
    } else if (!workspaceId && confirmed && session.status === 'anonymous') {
      // Signed out of the last workspace (or the whole session is gone).
      confirmed = null;
      forgetWorkspace();
    }

    if (session.leaving && !leaving) {
      leaving = true;

      const { signedIn } = session.leaving;
      const next = signedIn ? nextAfterSignOut(signedIn, lastWorkspace()) : null;

      if (next) {
        switchWorkspace(next, { kind: 'signed-out', name: session.me?.workspaceName ?? 'the workspace' });
      } else {
        leaveSignedOutWorkspace();
      }
    }
  });

  const onBack = () => {
    if (document.visibilityState === 'visible') {
      rememberLastWorkspace();
    }
  };

  document.addEventListener('visibilitychange', onBack);
  window.addEventListener('focus', onBack);

  return () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', onBack);
    window.removeEventListener('focus', onBack);
  };
}
