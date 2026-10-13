// The loader of the installation's remote agent kinds over a temporary
// directory of extension modules: a valid kind loads with the context its
// start() received; a module that exports anything but start, whose
// declaration fails validation, or whose name shadows a repository agent is
// skipped — reported, never fatal — and the rest still load. No database:
// the loader is pure over the files (the secrets side is
// remote-agent-secrets.ts).
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RemoteDriverContext } from '../core/contract.ts';
import { getLoadedRemoteKind, loadRemoteAgents } from './remote-agent-source.ts';
import type { RemoteAgentLoadFailure } from './remote-agent-source.ts';

let directory: string;

const DRIVER = `{
  open: async () => ({ ref: 'r' }), describe: async () => ({ exists: true }), read: async () => ({ cursor: null, phase: 'idle', items: [] }),
  say: async () => {}, answer: async () => {}, stop: async () => {},
}`;

function kindModule(name: string, extra = ''): string {
  return `export async function start(ctx) {
  globalThis.__remoteStartCtx = ctx;
  return { kind: 'remote', name: '${name}', description: 'A fake external system', options: { type: 'object', properties: { harness: { type: 'string', default: 'pi' } } }, secrets: ['TOKEN'], driver: ${DRIVER}${extra} };
}
`;
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'remote-agents-'));
  await writeFile(path.join(directory, 'fake_agent.ts'), kindModule('fake_agent'));
  await writeFile(path.join(directory, 'no_start.ts'), `export const agent = {};\n`);
  await writeFile(path.join(directory, 'extra_export.ts'), `export function start() { return {}; }\nexport const other = 1;\n`);
  await writeFile(path.join(directory, 'engineer.ts'), kindModule('engineer'));
  await writeFile(path.join(directory, 'renamed.ts'), kindModule('other_name'));
  await writeFile(path.join(directory, 'required_options.ts'), kindModule('required_options', ", options: { type: 'object', properties: {}, required: ['x'] }"));
  await writeFile(path.join(directory, 'broken.ts'), `export function start() { throw new Error('no network'); }\n`);
  await writeFile(path.join(directory, 'notes.md'), 'not a module');
});

after(() => rm(directory, { recursive: true, force: true }));

describe('loadRemoteAgents', () => {
  test('loads the valid kinds, skips and reports the rest, and remembers each kind with its context', async () => {
    const failures: RemoteAgentLoadFailure[] = [];
    const contexts = new Map<string, RemoteDriverContext>();
    const context = (kind: string): RemoteDriverContext => {
      const ctx = { secrets: { get: async () => `secret-of-${kind}` }, files: {} as RemoteDriverContext['files'] };

      contexts.set(kind, ctx);

      return ctx;
    };

    const loaded = await loadRemoteAgents({
      directory,
      context,
      repositoryAgents: new Set(['engineer']),
      report: async failure => {
        failures.push(failure);
      },
    });

    assert.deepEqual(loaded.map(declaration => declaration.name), ['fake_agent']);
    assert.equal(loaded[0].kind, 'remote');
    assert.deepEqual(loaded[0].secrets, ['TOKEN']);
    assert.equal(typeof loaded[0].driver.read, 'function');
    // start() ran with the kind's own context (the files load in name order;
    // required_options.ts is the last start() that ran).
    assert.equal((globalThis as { __remoteStartCtx?: unknown }).__remoteStartCtx, contexts.get('required_options'));
    assert.equal(await contexts.get('fake_agent')!.secrets.get('TOKEN'), 'secret-of-fake_agent');
    assert.equal(getLoadedRemoteKind('fake_agent')?.context, contexts.get('fake_agent'));
    assert.equal(getLoadedRemoteKind('engineer'), null);

    const byFile = Object.fromEntries(failures.map(failure => [failure.file, failure.error]));

    assert.deepEqual(Object.keys(byFile).sort(), ['broken.ts', 'engineer.ts', 'extra_export.ts', 'no_start.ts', 'renamed.ts', 'required_options.ts']);
    assert.match(byFile['no_start.ts'], /must export only "start"/);
    assert.match(byFile['extra_export.ts'], /must export only "start"/);
    assert.match(byFile['engineer.ts'], /shadows a repository agent/);
    assert.match(byFile['renamed.ts'], /must equal filename "renamed"/);
    assert.match(byFile['required_options.ts'], /must not declare required/);
    assert.match(byFile['broken.ts'], /no network/);
  });

  test('an absent directory loads nothing', async () => {
    const loaded = await loadRemoteAgents({
      directory: path.join(directory, 'missing'),
      context: () => ({ secrets: { get: async () => '' }, files: {} as RemoteDriverContext['files'] }),
      repositoryAgents: new Set(),
    });

    assert.deepEqual(loaded, []);
    assert.equal(getLoadedRemoteKind('fake_agent'), null);
  });
});
