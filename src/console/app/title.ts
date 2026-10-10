// document.title from the route and the data behind it.

import type { State } from '../store/types.ts';

const SECTION_TITLES: Record<string, string> = {
  home: 'Home',
  threads: 'Threads',
  projects: 'Projects',
  files: 'Files',
  apps: 'Apps',
  schedule: 'Schedule',
  connections: 'Connections',
  secrets: 'Secrets',
  agents: 'Agents',
  system: 'System',
  settings: 'Settings',
  dev_ui: 'UI kit',
  login: 'Sign in',
  not_found: 'Not found',
};

export function selectTitle(state: State): string {
  const { route } = state.router;
  let title = SECTION_TITLES[route.key] ?? 'Balabash';

  if (route.key === 'thread') {
    const thread = state.threads.byId[route.id];

    title = thread?.title ?? thread?.agent ?? 'Thread';
  } else if (route.key === 'project') {
    title = state.projects.ids.map(id => state.projects.byId[id]).find(project => project?.slug === route.slug)?.title ?? route.slug;
  } else if (route.key === 'files' && route.path) {
    title = route.path.split('/').pop() ?? title;
  } else if (route.key === 'agents' && route.name) {
    title = route.name;
  }

  return route.key === 'home' ? 'Balabash' : `${title} · Balabash`;
}
