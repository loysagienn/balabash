// The routing table of the console (frontend.md, "Роутер"). Everything the
// URL says is in the route object, search params included: list filters,
// the selected item of a split view, the editor mode. readRoute and
// writeRoute are inverses (routes.test.ts).

import type { ThreadStatus } from '../../../core/contract.ts';
import { isDayKey } from '../format/index.ts';
import { defineRoute, encodePath, initRouter, queryString, segments } from './types.ts';
import type { InferRoute } from './types.ts';

const THREAD_STATUSES: ThreadStatus[] = ['active', 'completed', 'failed', 'cancelled'];

export type ThreadsFilters = {
  status?: ThreadStatus;
  agent?: string;
  // A project slug (the snapshot maps it to the projectId).
  project?: string;
  q?: string;
  // The period: local calendar days "YYYY-MM-DD", both ends inclusive, either
  // one alone an open range (the store turns them into createdAtGte/Lte).
  from?: string;
  to?: string;
};

export type HomeRoute = { key: 'home' };
export type ThreadsRoute = { key: 'threads' } & ThreadsFilters;
export type ThreadRoute = { key: 'thread'; id: string };
export type ProjectsRoute = { key: 'projects'; archived?: boolean; q?: string };
export type ProjectRoute = { key: 'project'; slug: string; path?: string; view?: 'edit' };
export type FilesRoute = { key: 'files'; path: string; view?: 'edit' };
export type AppsFilter = 'published' | 'errors';
export type AppsRoute = { key: 'apps'; filter?: AppsFilter; q?: string };
// slug — the selected task (/schedule/<slug>, a detail screen on the
// phone); tab 'log' — the run log instead of the tasks, task — the log of
// one task; q — the tasks search.
export type ScheduleRoute = { key: 'schedule'; slug?: string; tab?: 'log'; task?: string; q?: string };
export type ConnectionsRoute = { key: 'connections' };
export type SecretsRoute = { key: 'secrets'; id: string };
export type AgentsRoute = { key: 'agents'; name?: string; q?: string };
export type SystemRoute = { key: 'system' };
export type SettingsRoute = { key: 'settings' };
export type DevUiRoute = { key: 'dev_ui'; section?: string };
// The sign-in door with a way back: `next` is where to go once signed in —
// a path of this host, SPA route or not (the owner page of an app under
// /apps/<path> sends the browser here when the session is missing).
export type LoginRoute = { key: 'login'; next?: string };
export type NotFoundRoute = { key: 'not_found'; url: string };

const param = (params: URLSearchParams, name: string): string | undefined => {
  const value = params.get(name);

  return value ? value : undefined;
};

export const home = defineRoute<HomeRoute>({
  key: 'home',
  readRoute: path => (segments(path).length === 0 ? { key: 'home' } : null),
  writeRoute: () => '/',
});

export const threads = defineRoute<ThreadsRoute>({
  key: 'threads',
  readRoute: (path, params) => {
    const parts = segments(path);

    if (parts.length !== 1 || parts[0] !== 'threads') {
      return null;
    }

    const status = param(params, 'status');
    const route: ThreadsRoute = { key: 'threads' };

    if (status && (THREAD_STATUSES as string[]).includes(status)) {
      route.status = status as ThreadStatus;
    }

    const agent = param(params, 'agent');
    const project = param(params, 'project');
    const q = param(params, 'q');
    const from = param(params, 'from');
    const to = param(params, 'to');

    if (agent) route.agent = agent;
    if (project) route.project = project;
    if (q) route.q = q;
    if (from && isDayKey(from)) route.from = from;
    if (to && isDayKey(to)) route.to = to;

    return route;
  },
  writeRoute: route => `/threads${queryString({ status: route.status, agent: route.agent, project: route.project, q: route.q, from: route.from, to: route.to })}`,
});

export const thread = defineRoute<ThreadRoute>({
  key: 'thread',
  readRoute: path => {
    const parts = segments(path);

    return parts.length === 2 && parts[0] === 'threads' ? { key: 'thread', id: parts[1] } : null;
  },
  writeRoute: route => `/threads/${encodeURIComponent(route.id)}`,
});

export const projects = defineRoute<ProjectsRoute>({
  key: 'projects',
  readRoute: (path, params) => {
    const parts = segments(path);

    if (parts.length !== 1 || parts[0] !== 'projects') {
      return null;
    }

    const route: ProjectsRoute = { key: 'projects' };
    const q = param(params, 'q');

    if (params.get('archived') === '1') route.archived = true;
    if (q) route.q = q;

    return route;
  },
  writeRoute: route => `/projects${queryString({ archived: route.archived ? '1' : undefined, q: route.q })}`,
});

export const project = defineRoute<ProjectRoute>({
  key: 'project',
  readRoute: (path, params) => {
    const parts = segments(path);

    if (parts.length < 2 || parts[0] !== 'projects') {
      return null;
    }

    if (parts.length === 2) {
      return { key: 'project', slug: parts[1] };
    }

    if (parts[2] === 'files') {
      const route: ProjectRoute = { key: 'project', slug: parts[1], path: parts.slice(3).join('/') };

      if (params.get('view') === 'edit') {
        route.view = 'edit';
      }

      return route;
    }

    return null;
  },
  writeRoute: route => {
    const base = `/projects/${encodeURIComponent(route.slug)}`;

    return route.path === undefined ? base : `${base}/files${route.path ? `/${encodePath(route.path)}` : ''}${queryString({ view: route.view })}`;
  },
});

// The Files section lives at /workspace: on the console host /files/* is
// the byte surface of the file area itself (server.md), so the screen's
// own URL cannot start there.
export const files = defineRoute<FilesRoute>({
  key: 'files',
  readRoute: (path, params) => {
    const parts = segments(path);

    if (parts.length < 1 || parts[0] !== 'workspace') {
      return null;
    }

    const route: FilesRoute = { key: 'files', path: parts.slice(1).join('/') };

    if (params.get('view') === 'edit') {
      route.view = 'edit';
    }

    return route;
  },
  writeRoute: route => `/workspace${route.path ? `/${encodePath(route.path)}` : ''}${queryString({ view: route.view })}`,
});

const simple = <K extends string>(key: K, segment: string) =>
  defineRoute<{ key: K }>({
    key,
    readRoute: path => {
      const parts = segments(path);

      return parts.length === 1 && parts[0] === segment ? { key } : null;
    },
    writeRoute: () => `/${segment}`,
  });

const APPS_FILTERS: AppsFilter[] = ['published', 'errors'];

// The Apps section: the segment (All · Published · With errors) and the
// search are the route, like the filters of Threads.
export const apps = defineRoute<AppsRoute>({
  key: 'apps',
  readRoute: (path, params) => {
    const parts = segments(path);

    if (parts.length !== 1 || parts[0] !== 'apps') {
      return null;
    }

    const route: AppsRoute = { key: 'apps' };
    const filter = param(params, 'filter');
    const q = param(params, 'q');

    if (filter && (APPS_FILTERS as string[]).includes(filter)) {
      route.filter = filter as AppsFilter;
    }
    if (q) route.q = q;

    return route;
  },
  writeRoute: route => `/apps${queryString({ filter: route.filter, q: route.q })}`,
});

export const connections = simple('connections', 'connections');
export const system = simple('system', 'system');
export const settings = simple('settings', 'settings');

export const schedule = defineRoute<ScheduleRoute>({
  key: 'schedule',
  readRoute: (path, params) => {
    const parts = segments(path);

    if (parts[0] !== 'schedule' || parts.length > 2) {
      return null;
    }

    const q = param(params, 'q');

    if (parts.length === 2) {
      const route: ScheduleRoute = { key: 'schedule', slug: parts[1] };

      if (q) route.q = q;

      return route;
    }

    const route: ScheduleRoute = { key: 'schedule' };
    const tab = param(params, 'tab');
    const task = param(params, 'task');

    if (tab === 'log') {
      route.tab = 'log';

      if (task) route.task = task;
    } else if (q) {
      route.q = q;
    }

    return route;
  },
  writeRoute: route => (route.slug ? `/schedule/${encodeURIComponent(route.slug)}${queryString({ q: route.q })}` : `/schedule${queryString(route.tab === 'log' ? { tab: 'log', task: route.task } : { q: route.q })}`),
});

export const secrets = defineRoute<SecretsRoute>({
  key: 'secrets',
  readRoute: path => {
    const parts = segments(path);

    return parts.length === 2 && parts[0] === 'secrets' ? { key: 'secrets', id: parts[1] } : null;
  },
  writeRoute: route => `/secrets/${encodeURIComponent(route.id)}`,
});

// The Agents section: the selected agent of the split view is the path,
// the catalog search is the query.
export const agents = defineRoute<AgentsRoute>({
  key: 'agents',
  readRoute: (path, params) => {
    const parts = segments(path);

    if (parts[0] !== 'agents' || parts.length > 2) {
      return null;
    }

    const route: AgentsRoute = parts.length === 2 ? { key: 'agents', name: parts[1] } : { key: 'agents' };
    const q = param(params, 'q');

    if (q) route.q = q;

    return route;
  },
  writeRoute: route => `/agents${route.name ? `/${encodeURIComponent(route.name)}` : ''}${queryString({ q: route.q })}`,
});

export const devUi = defineRoute<DevUiRoute>({
  key: 'dev_ui',
  readRoute: (path, params) => {
    const parts = segments(path);

    if (parts.length !== 2 || parts[0] !== 'dev' || parts[1] !== 'ui') {
      return null;
    }

    const section = param(params, 'section');

    return section ? { key: 'dev_ui', section } : { key: 'dev_ui' };
  },
  writeRoute: route => `/dev/ui${queryString({ section: route.section })}`,
});

// A post-sign-in destination survives only as a path of this host, in the
// form the browser will actually navigate by: the string is parsed against
// a fixed local base the way the address bar would parse it — a backslash
// is a slash, a tab or a newline between the slashes is dropped ("/\t/host"
// is "//host") — and it passes only when the parsed origin is still the
// base's; what comes back is the parsed path, query and fragment, never the
// string as written, so the check and the navigation read one URL. A string
// without a leading slash, another origin or one the parser refuses — null.
const LOCAL_BASE = 'https://local.invalid';

export function localPath(value: string): string | null {
  if (!value.startsWith('/')) {
    return null;
  }

  try {
    const url = new URL(value, LOCAL_BASE);

    return url.origin === LOCAL_BASE ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
}

export const login = defineRoute<LoginRoute>({
  key: 'login',
  readRoute: (path, params) => {
    const parts = segments(path);

    if (parts.length !== 1 || parts[0] !== 'login') {
      return null;
    }

    const next = param(params, 'next');
    const local = next ? localPath(next) : null;

    return local ? { key: 'login', next: local } : { key: 'login' };
  },
  writeRoute: route => `/login${queryString({ next: route.next })}`,
});

export const notFound = defineRoute<NotFoundRoute>({
  key: 'not_found',
  readRoute: (path, params) => {
    const search = params.toString();

    return { key: 'not_found', url: search ? `${path}?${search}` : path };
  },
  writeRoute: route => route.url,
});

export const router = initRouter([
  home,
  threads,
  thread,
  projects,
  project,
  files,
  apps,
  schedule,
  connections,
  secrets,
  agents,
  system,
  settings,
  devUi,
  login,
  notFound,
] as const);

export type AppRoute = ReturnType<typeof router.readRoute>;

// The addresses of the old web interface, read as the console's routes: an
// old bookmark or a link in an old chat message lands on the same screen, and
// the history process writes the console's own URL over it (writeRoute, as
// the first replaceState). Path only — the old pages had no filters to carry.
const OLD_WEB_PATHS: Record<string, string> = {
  '/thread': '/threads',
  '/applications': '/apps',
  '/llm-usage': '/system',
};

export function fromOldWeb(url: string): string {
  const first = /^\/[^/?#]+/.exec(url)?.[0];

  if (!first || !Object.hasOwn(OLD_WEB_PATHS, first)) {
    return url;
  }

  return `${OLD_WEB_PATHS[first]}${url.slice(first.length)}`;
}

export const readRoute = (url: string): AppRoute => router.readRoute(fromOldWeb(url));
export const { writeRoute } = router;

// The shell's sections: which route keys belong to which navigation item.
export type NavKey =
  | 'home'
  | 'threads'
  | 'projects'
  | 'files'
  | 'apps'
  | 'schedule'
  | 'connections'
  | 'agents'
  | 'system'
  | 'settings';

export function navKeyOf(route: AppRoute): NavKey | null {
  switch (route.key) {
    case 'home':
      return 'home';
    case 'threads':
    case 'thread':
      return 'threads';
    case 'projects':
    case 'project':
      return 'projects';
    case 'files':
      return 'files';
    case 'apps':
    case 'schedule':
    case 'connections':
    case 'agents':
    case 'system':
    case 'settings':
      return route.key;
    default:
      return null;
  }
}
