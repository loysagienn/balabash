// The two file areas and the bridge between them.
export const WORKSPACE_STORAGE_NOTE =
  'Files live in two areas: the workspace file area (path-addressed; the workspace_* tools and run_script) ' +
  'and Balabash file storage (fileId-addressed; storage_get_file, send_file, end_thread fileIds, message ' +
  'attachments). The bridge: workspace_export_file uploads a workspace file into storage and returns a ' +
  'fileId — the way a produced file reaches the user; workspace_import_file saves a stored file into the ' +
  'workspace file area — including binary files, which workspace_write_file cannot write.';
