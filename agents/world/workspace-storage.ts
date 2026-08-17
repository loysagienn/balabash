// The two file areas and the bridge between them.
export const WORKSPACE_STORAGE_NOTE =
  'Files live in two areas: the workspace file area (path-addressed) and Balabash file storage ' +
  '(fileId-addressed). The bridge: workspace_export_file uploads a workspace file into storage and returns ' +
  'a fileId — the way a produced file reaches the user; workspace_import_file saves a stored file into the ' +
  'workspace file area, binary files included. Give files descriptive names: the filename travels across ' +
  'every boundary and stays the main carrier of meaning for a human.';
