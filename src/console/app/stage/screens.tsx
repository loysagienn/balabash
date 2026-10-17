// The screen of a route: the switch the stage renders for every page it
// holds (one page, or two while one slides over the other).

import type { ReactNode } from 'react';
import type { AppRoute } from '../../lib/router/routes.ts';
import { ProjectScreen } from '../../screens/project/ProjectScreen.tsx';
import { ProjectsScreen } from '../../screens/projects/ProjectsScreen.tsx';
import { LoginLanding } from '../../screens/outside/LoginLanding.tsx';
import { NotFound } from '../../screens/outside/NotFound.tsx';
import { Secrets } from '../../screens/outside/Secrets.tsx';
import { AgentsScreen } from '../../screens/agents/AgentsScreen.tsx';
import { ConnectionsScreen } from '../../screens/connections/ConnectionsScreen.tsx';
import { AppsScreen } from '../../screens/apps/AppsScreen.tsx';
import { FilesScreen } from '../../screens/files/FilesScreen.tsx';
import { HomeScreen } from '../../screens/home/HomeScreen.tsx';
import { ThreadScreen } from '../../screens/thread/ThreadScreen.tsx';
import { ThreadsScreen } from '../../screens/threads/ThreadsScreen.tsx';
import { SettingsScreen } from '../../screens/settings/SettingsScreen.tsx';
import { ScheduleScreen } from '../../screens/schedule/ScheduleScreen.tsx';
import { SystemScreen } from '../../screens/system/SystemScreen.tsx';
import { DevUi } from '../../screens/dev-ui/DevUi.tsx';

export function screenOf(route: AppRoute): ReactNode {
  switch (route.key) {
    case 'home':
      return <HomeScreen />;
    case 'threads':
      return <ThreadsScreen route={route} />;
    case 'thread':
      return <ThreadScreen id={route.id} />;
    case 'projects':
      return <ProjectsScreen route={route} />;
    case 'project':
      return <ProjectScreen route={route} />;
    case 'files':
      return <FilesScreen route={route} />;
    case 'apps':
      return <AppsScreen route={route} />;
    case 'schedule':
      return <ScheduleScreen route={route} />;
    case 'connections':
      return <ConnectionsScreen />;
    case 'secrets':
      // One instance per id: the values typed and the call in flight belong
      // to the request they were typed for, never to the next id.
      return <Secrets key={route.id} id={route.id} />;
    case 'agents':
      return <AgentsScreen route={route} />;
    case 'system':
      return <SystemScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'dev_ui':
      return <DevUi />;
    case 'login':
      return <LoginLanding next={route.next} />;
    case 'not_found':
      return <NotFound url={route.url} />;
  }
}
