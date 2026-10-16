// The root: the session gate and the stage of the screens (app/stage —
// the route's screen, and the pages sliding over one another on the
// phone). Anonymous — the sign-in card over any route (the route stays;
// after sign-in the screen the link led to appears; the /login door itself
// leads on to its `next`). The document title follows the route and its
// data.

import { useEffect } from 'react';
import { useAppSelector } from '../store/hooks.ts';
import { selectRoute } from '../store/router/selectors.ts';
import { selectSession } from '../store/session/selectors.ts';
import { NotFound } from '../screens/outside/NotFound.tsx';
import { SessionError } from '../screens/outside/SessionError.tsx';
import { SignIn } from '../screens/outside/SignIn.tsx';
import { Stage } from './stage/Stage.tsx';
import { selectTitle } from './title.ts';

export function App() {
  const session = useAppSelector(selectSession);
  const route = useAppSelector(selectRoute);
  const title = useAppSelector(selectTitle);

  useEffect(() => {
    document.title = title;
  }, [title]);

  // Screens that work without a session.
  if (route.key === 'not_found') {
    return <NotFound url={route.url} />;
  }

  switch (session.status) {
    case 'loading':
      return null;
    case 'error':
      return <SessionError error={session.error ?? { status: 0, code: 'unknown', message: 'unknown error' }} />;
    case 'anonymous':
      return <SignIn />;
    case 'signed-in':
      break;
  }

  return <Stage />;
}
