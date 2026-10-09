// Files — the file area rooted at the whole workspace folder (design rule
// 17); the project page mounts the same FileBrowser with its own root. The
// path is the route; the node behind it decides whether the screen is a
// folder or a file (the shell changes with it, FilesScreen.logic.ts). The
// area fills the shell body: its rows and the preview scroll on their own.

import type { FilesRoute } from '../../lib/router/routes.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { FileBrowser } from '../../features/file-area/FileBrowser.tsx';
import { nodeOf } from '../../features/file-area/node.ts';
import { useWorkspaceNode } from '../../features/file-area/queries.ts';
import { filesRoute, filesShell } from './FilesScreen.logic.ts';
import './FilesScreen.css';

export function FilesScreen({ route }: { route: FilesRoute }) {
  const node = useWorkspaceNode(route.path);
  const shell = filesShell(route.path, nodeOf(node)?.kind ?? null);

  return (
    <Shell current="files" title={shell.title} titleNarrow={shell.titleNarrow} crumb={shell.crumb} back={shell.back} detail={shell.detail}>
      <FileBrowser root="" rootLabel="Files" path={route.path} routeFor={filesRoute} className="fil-fa" />
    </Shell>
  );
}
