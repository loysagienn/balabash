// Static local tool-server index: the servers ship inside the app bundle —
// adding one is adding its module here (the claude agent does it itself).
// Each module still must export only start(ctx); validation happens in
// startLocalToolSource at boot.

import * as current_datetime from './current_datetime.ts';
import * as gmail from './gmail.ts';
import * as storage_download_file from './storage_download_file.ts';
import * as web_fetch from './web_fetch.ts';
import * as workspace from './workspace.ts';

export const localToolModules: Record<string, Record<string, unknown>> = {
  current_datetime,
  gmail,
  storage_download_file,
  web_fetch,
  workspace,
};
