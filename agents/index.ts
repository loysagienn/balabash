// Static agent index: agents ship inside the app bundle — adding an agent is
// adding its module here (the claude agent does it itself). Dynamic import
// machinery is gone with hot-reload: the only reload is an app restart, and a
// broken declaration fails the boot — the supervisor then rolls back to the
// last good bundle. Declarations are still validated hard at boot
// (validate-agent), so each entry is the raw module namespace, not a trusted
// AgentDeclaration.

import * as architect from './architect.ts';
import * as auth from './auth.ts';
import * as browser from './browser.ts';
import * as claude from './claude.ts';
import * as codex from './codex.ts';
import * as discussion from './discussion.ts';

export const agentModules: Record<string, Record<string, unknown>> = {
  architect,
  auth,
  browser,
  claude,
  codex,
  discussion,
};
