// The single owner of the workspace-area disk layout. The app process always
// starts in the repository root (§12), so the area resolves from cwd. Every
// module that needs a workspace path derives it from here — tools/workspace.ts
// (the workbench tool server), workbench agents' cwd, the projects module —
// so the layout is written down exactly once.
//
// Layout on disk (per userId):
//   data/workspace/<userId>/workspace.sqlite  — the workbench database
//   data/workspace/<userId>/files/            — file area, cwd of workbench agents
//   data/workspace/<userId>/tmp/              — transient inline-script files
//   data/workspace/<userId>/tasks/            — scheduled task bodies (kind code)

import path from 'node:path';

export function workspaceRoot(): string {
  return path.resolve('data', 'workspace');
}

export function workspaceFilesDir(userId: string): string {
  return path.join(workspaceRoot(), userId, 'files');
}

export function workspaceDbPath(userId: string): string {
  return path.join(workspaceRoot(), userId, 'workspace.sqlite');
}

// Scheduled task bodies of the workspace (src/capabilities/extensions.ts):
// <slug>.ts files exporting run(ctx), loaded at fire time.
export function workspaceTasksDir(userId: string): string {
  return path.join(workspaceRoot(), userId, 'tasks');
}
