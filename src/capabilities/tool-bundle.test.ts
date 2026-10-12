// The bundle rule: a repository server reaches a passport only by name; the
// installation's extension servers (data/tools, data/mcp-servers) reach every
// passport that names "projects", and no other.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectiveBundleServers, listGrants } from './tool-manager.ts';

describe('the bundle rule for the installation’s extension servers', () => {
  const extensions = ['slack', 'youtrack'];

  it('grants a repository server by name only', () => {
    assert.equal(listGrants(['projects', 'notion'], 'notion', extensions), true);
    assert.equal(listGrants(['projects'], 'notion', extensions), false);
  });

  it('grants every extension server to a list that names projects, none to one that does not', () => {
    assert.equal(listGrants(['projects', 'storage'], 'slack', extensions), true);
    assert.equal(listGrants(['projects'], 'youtrack', extensions), true);
    assert.equal(listGrants(['workspace', 'storage'], 'slack', extensions), false);
    assert.equal(listGrants(['workspace', 'slack'], 'slack', extensions), true);
  });

  it('shows a passport as it acts: the extensions after the listed names, once', () => {
    assert.deepEqual(effectiveBundleServers(['projects', 'storage'], extensions), ['projects', 'storage', 'slack', 'youtrack']);
    assert.deepEqual(effectiveBundleServers(['projects', 'slack'], extensions), ['projects', 'slack', 'youtrack']);
    assert.deepEqual(effectiveBundleServers(['auth', 'storage'], extensions), ['auth', 'storage']);
  });
});
