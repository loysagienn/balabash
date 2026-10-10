// The signed-in side of the /login door (/login?next=…): nothing to show,
// the door leads on. A route of the SPA is entered in place, replacing the
// door's history entry so Back skips it; a path the SPA does not serve —
// the owner page of an app, the shared surfaces — is a full navigation
// that replaces the entry the same way (SignIn.logic.ts, loginDestination).

import { useEffect } from 'react';
import { useAppDispatch } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { loginDestination } from './SignIn.logic.ts';

export function LoginLanding({ next }: { next?: string }) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    const destination = loginDestination(next);

    if (destination.kind === 'route') {
      dispatch(routeTo(destination.route, { replace: true, hash: destination.hash }));
    } else {
      window.location.replace(destination.url);
    }
  }, [dispatch, next]);

  return null;
}
