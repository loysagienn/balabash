// The hierarchy of the routes: which screens are nested pages (a page with
// "back" in its header — a thread under the list, a project under the
// projects, a folder under its parent, a task or an agent chosen out of a
// split view on the phone), where "back" leads from each, and which route
// changes stay on the same page. One source for the screens' headers, the
// unified "back" (store/router) and the stage that slides the pages in and
// out (app/stage). The screens keep their own words; the routes come from
// here.

import type { AppRoute } from './routes.ts';

function parentOf(path: string): string {
  const at = path.lastIndexOf('/');

  return at < 0 ? '' : path.slice(0, at);
}

// Where "back" leads from the route; null for a top-level screen.
export function parentRoute(route: AppRoute): AppRoute | null {
  switch (route.key) {
    case 'thread':
      return { key: 'threads' };
    case 'project': {
      // The project page (and the root of its files, which is the page
      // itself) goes back to the list; a folder or a file below — up one
      // level, the top level being the page.
      if (!route.path) {
        return { key: 'projects' };
      }

      const parent = parentOf(route.path);

      return parent === '' ? { key: 'project', slug: route.slug } : { key: 'project', slug: route.slug, path: parent };
    }
    case 'files':
      return route.path === '' ? null : { key: 'files', path: parentOf(route.path) };
    case 'schedule': {
      if (route.new) {
        const { new: _new, ...rest } = route;

        return rest;
      }

      if (route.slug) {
        const { slug: _slug, ...rest } = route;

        return rest;
      }

      return null;
    }
    case 'agents': {
      if (!route.name) {
        return null;
      }

      const { name: _name, ...rest } = route;

      return rest;
    }
    default:
      return null;
  }
}

// A nested page: one with a parent to go back to.
export function nested(route: AppRoute): boolean {
  return parentRoute(route) !== null;
}

// Moving inside one page keeps the place: the file area of a project page
// sits below its header and threads, and a folder, a file or a crumb opened
// there changes the route without changing the page (the screen itself
// brings the file area into view).
export function samePage(from: AppRoute, to: AppRoute): boolean {
  return from.key === 'project' && to.key === 'project' && from.slug === to.slug;
}
