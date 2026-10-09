// A route is a typed object; a RouteConfig knows how to read it from a URL
// and write it back. initRouter() takes the configs in priority order (the
// first that reads the URL wins; the catch-all comes last) and infers the
// union of routes from them — nothing else describes the routing table.

export type RouteBase = { key: string };

// Method signatures on purpose: they are checked bivariantly, so a
// RouteConfig<ThreadRoute> fits where a RouteConfig<RouteBase> is expected
// (the configs of initRouter).
export type RouteConfig<R extends RouteBase> = {
  key: R['key'];
  readRoute(path: string, params: URLSearchParams): R | null;
  writeRoute(route: R): string;
};

export type InferRoute<C> = C extends RouteConfig<infer R> ? R : never;

// Identity with inference: `route<ThreadRoute>({ … })` types both callbacks.
export function defineRoute<R extends RouteBase>(config: RouteConfig<R>): RouteConfig<R> {
  return config;
}

export type Router<Route extends RouteBase> = {
  // A path with an optional query string ("/threads/42?x=1"); never throws —
  // the last config is the catch-all.
  readRoute: (url: string) => Route;
  writeRoute: (route: Route) => string;
};

export function initRouter<const C extends readonly RouteConfig<RouteBase>[]>(configs: C): Router<InferRoute<C[number]>> {
  type Route = InferRoute<C[number]>;

  const byKey = new Map<string, RouteConfig<RouteBase>>(configs.map(config => [config.key, config]));

  return {
    readRoute(url) {
      const { pathname, searchParams } = new URL(url, 'http://router.local');

      for (const config of configs) {
        const route = config.readRoute(pathname, searchParams);

        if (route) {
          return route as Route;
        }
      }

      throw new Error(`router: no config read "${url}" — the catch-all is missing`);
    },
    writeRoute(route) {
      const config = byKey.get(route.key);

      if (!config) {
        throw new Error(`router: unknown route key "${route.key}"`);
      }

      return config.writeRoute(route);
    },
  };
}

// --- path helpers ---------------------------------------------------------

// "/a/b%20c/" → ["a", "b c"]; the root → [].
export function segments(path: string): string[] {
  return path
    .split('/')
    .filter(Boolean)
    .map(segment => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

// Encodes every segment of a slash-separated path, keeps the slashes.
export function encodePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

export function queryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, value);
    }
  }

  const text = search.toString();

  return text ? `?${text}` : '';
}
