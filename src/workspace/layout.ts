// The single owner of the workspace-area disk layout. The app process always
// starts in the repository root (§12), so the area resolves from cwd. Every
// module that needs a workspace path derives it from here — tools/workspace.ts
// (the workbench tool server), workbench agents' cwd, the projects module —
// so the layout is written down exactly once.
//
// Layout on disk (per workspaceId):
//   data/workspace/<workspaceId>/workspace.sqlite  — the workbench database
//   data/workspace/<workspaceId>/files/            — file area, cwd of workbench agents
//   data/workspace/<workspaceId>/tmp/              — transient inline-script files
//   data/workspace/<workspaceId>/tasks/            — scheduled task bodies (kind code)

import path from 'node:path';

export function workspaceRoot(): string {
  return path.resolve('data', 'workspace');
}

export function workspaceFilesDir(workspaceId: string): string {
  return path.join(workspaceRoot(), workspaceId, 'files');
}

export function workspaceDbPath(workspaceId: string): string {
  return path.join(workspaceRoot(), workspaceId, 'workspace.sqlite');
}

// Scheduled task bodies of the workspace (src/capabilities/extensions.ts):
// <slug>.ts files exporting run(ctx), loaded at fire time.
export function workspaceTasksDir(workspaceId: string): string {
  return path.join(workspaceRoot(), workspaceId, 'tasks');
}

// Transient files of the workspace: inline scripts of the tools, the bytes
// of an upload to the file area while they arrive (outside files/, so a
// listing never shows a half-received file; the same volume, so the finished
// file is linked into place, not copied).
export function workspaceTmpDir(workspaceId: string): string {
  return path.join(workspaceRoot(), workspaceId, 'tmp');
}
