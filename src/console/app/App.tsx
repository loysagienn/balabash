// The root: the session gate and the route switch. Anonymous — the sign-in
// card over any route (the route stays; after sign-in the screen the link
// led to appears). The document title follows the route and its data.

import { useEffect } from 'react';
import { useAppSelector } from '../store/hooks.ts';
import { selectRoute } from '../store/router/selectors.ts';
import { selectSession } from '../store/session/selectors.ts';
import { Placeholder } from '../screens/Placeholder.tsx';
import { NotFound } from '../screens/outside/NotFound.tsx';
import { SessionError } from '../screens/outside/SessionError.tsx';
import { SignIn } from '../screens/outside/SignIn.tsx';
import { ThreadScreen } from '../screens/thread/ThreadScreen.tsx';
import { ThreadsScreen } from '../screens/threads/ThreadsScreen.tsx';
import { SettingsScreen } from '../screens/settings/SettingsScreen.tsx';
import { DevUi } from '../screens/dev-ui/DevUi.tsx';
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

  switch (route.key) {
    case 'home':
      return <Placeholder current="home" title="Home" icon="house" what="Home" />;
    case 'threads':
      return <ThreadsScreen route={route} />;
    case 'thread':
      return <ThreadScreen id={route.id} />;
    case 'projects':
      return <Placeholder current="projects" title="Projects" icon="folder" what="Projects" />;
    case 'project':
      return <Placeholder current="projects" title={route.slug} crumb={{ label: 'Projects', route: { key: 'projects' } }} back={{ key: 'projects' }} icon="folder" what="The project page" />;
    case 'files':
      return <Placeholder current="files" title="Files" icon="folder-tree" what="The file area" />;
    case 'apps':
      return <Placeholder current="apps" title="Apps" icon="layout-grid" what="Apps" />;
    case 'schedule':
      return <Placeholder current="schedule" title="Schedule" icon="calendar-clock" what="Schedule" />;
    case 'connections':
      return <Placeholder current="connections" title="Connections" icon="plug" what="Connections" />;
    case 'secrets':
      return <Placeholder current={null} title="Secrets" icon="wrench" what="Secrets entry" />;
    case 'agents':
      return <Placeholder current="agents" title="Agents" icon="bot" what="Agents" />;
    case 'system':
      return <Placeholder current="system" title="System" icon="activity" what="System" />;
    case 'settings':
      return <SettingsScreen />;
    case 'dev_ui':
      return <DevUi />;
  }
}
