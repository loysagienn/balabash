// The signed-in side of the /login door. Bare (/login — the link the
// Telegram /auth_code message carries) in a tab that was already signed in:
// the code is for one more workspace, so Home opens with "Sign in to another
// workspace". Signed in right here, or with ?next=…: nothing to show, the
// door leads on. A route of the SPA is entered in place, replacing the
// door's history entry so Back skips it; a path the SPA does not serve —
// the owner page of an app, the shared surfaces — is a full navigation
// that replaces the entry the same way (SignIn.logic.ts, loginDestination).

import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { openAddWorkspace } from '../../store/ui/actions.ts';
import { loginDestination } from './SignIn.logic.ts';

export function LoginLanding({ next }: { next?: string }) {
  const dispatch = useAppDispatch();
  const signedInHere = useAppSelector(state => state.session.signedInHere);

  useEffect(() => {
    // The bare door (the Telegram /auth_code link) in a signed-in tab: the
    // code is for one more workspace — Home with the code window open.
    if (next === undefined && !signedInHere) {
      dispatch(routeTo({ key: 'home' }, { replace: true }));
      dispatch(openAddWorkspace());

      return;
    }

    const destination = loginDestination(next);

    if (destination.kind === 'route') {
      dispatch(routeTo(destination.route, { replace: true, hash: destination.hash }));
    } else {
      window.location.replace(destination.url);
    }
  }, [dispatch, next, signedInHere]);

  return null;
}
