// The shell of the Files screen from the path and what it names (the node's
// kind, unknown while it loads — treated as a folder): the folder's name as
// the title with "Files" above it and "back" to the parent; at the root
// just "Files". A file is a detail screen: on the phone the title is the
// file's name and the tabs are hidden (the preview header names the file
// on wide screens, where the shell header names its folder).

import type { AppRoute } from '../../lib/router/routes.ts';
import { nameOf, parentOf } from '../../features/file-area/node.ts';

export type FilesShell = {
  title: string;
  titleNarrow?: string;
  crumb?: { label: string; route: AppRoute };
  back?: AppRoute;
  detail: boolean;
};

export const filesRoute = (path: string): AppRoute => ({ key: 'files', path });

const ROOT_CRUMB = { label: 'Files', route: filesRoute('') };

export function filesShell(path: string, kind: 'dir' | 'file' | null): FilesShell {
  if (path === '') {
    return { title: 'Files', detail: false };
  }

  const parent = parentOf(path);

  if (kind === 'file') {
    return {
      title: parent === '' ? 'Files' : nameOf(parent),
      titleNarrow: nameOf(path),
      crumb: parent === '' ? undefined : ROOT_CRUMB,
      back: filesRoute(parent),
      detail: true,
    };
  }

  return { title: nameOf(path), crumb: ROOT_CRUMB, back: filesRoute(parent), detail: false };
}
