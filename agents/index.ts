// Static agent index: agents ship inside the app bundle — adding an agent is
// adding its module here (the engineer agent does it itself). Dynamic import
// machinery is gone with hot-reload: the only reload is an app restart, and a
// broken declaration fails the boot — the supervisor then rolls back to the
// last good bundle. Declarations are still validated hard at boot
// (validate-agent), so each entry is the raw module namespace, not a trusted
// AgentDeclaration.

import * as architect from './architect.ts';
import * as auth from './auth.ts';
import * as browser from './browser.ts';
import * as codex from './codex.ts';
import * as engineer from './engineer.ts';
import * as manager from './manager.ts';
import * as power_point from './power_point.ts';
import * as scheduler from './scheduler.ts';

export const agentModules: Record<string, Record<string, unknown>> = {
  architect,
  auth,
  browser,
  codex,
  engineer,
  manager,
  power_point,
  scheduler,
};
