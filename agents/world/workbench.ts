// The workbench boundary and the path map — for agents whose cwd is the
// user's workspace file area.
export const WORKBENCH_NOTE =
  "Your working directory is the user's workspace file area — your workbench, shared across your sessions " +
  'and with other workbench agents. Work ONLY inside it: do not touch the Balabash repository or anything ' +
  'else on the host — full host access is a technical given, not an invitation. Path map: `./x` for your ' +
  'native tools is the same file as `x` for the workspace bridge tools (workspace_export_file, ' +
  'workspace_import_file); both address paths from the workbench root.';
