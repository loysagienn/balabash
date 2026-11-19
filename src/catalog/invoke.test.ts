// The call of a capability: the grant, the input type, the account, the
// action, the outcome.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CapabilityError, toCapabilityError } from './errors.ts';
import { computeGrant, type GrantPolicy } from './grant.ts';
import { call, invokeCapability } from './invoke.ts';
import { describe as describeVertex } from './describe.ts';
import { CALLER, OLD, WORK, testCatalog, testConnections, type Calls } from './test-tree.ts';

const calls: Calls = [];
const catalog = testCatalog(calls);
const connections = testConnections({ accounts: { mail: [WORK, OLD] }, secrets: ['search'] });
const env = { connections };
const grantOf = (policy: Partial<GrantPolicy> = {}) =>
  computeGrant(
    catalog,
    { allows: () => true, actions: ['describe', 'run_program'], ...policy },
    { caller: CALLER, connections },
  );

async function errorOf(promise: Promise<unknown>): Promise<CapabilityError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CapabilityError);

    return error;
  }

  assert.fail('expected the call to fail');
}

describe('the call of a capability', () => {
  it('gives the action the checked input with defaults and the caller, and returns its value', async () => {
    const grant = await grantOf();

    calls.length = 0;

    assert.deepEqual(await invokeCapability(grant, 'notes_list', { status: 'open' }, env), {
      notes: [{ id: 1, title: 'First', body: null, attachment: null }],
      nextCursor: null,
    });
    assert.deepEqual(calls, [
      {
        name: 'notes_list',
        input: { status: 'open', limit: 10 },
        ctx: { caller: CALLER, account: null, signal: null, program: null },
      },
    ]);
  });

  it('takes a missing input for an empty one, and an explicit null for a value that does not fit', async () => {
    const grant = await grantOf();

    assert.deepEqual(await invokeCapability(grant, 'notes_archive_purge', undefined, env), { purged: 0 });
    assert.deepEqual(await call(grant, { name: 'notes_archive_purge' }, env), { purged: 0 });

    calls.length = 0;

    assert.equal((await errorOf(invokeCapability(grant, 'notes_archive_purge', null, env))).kind, 'invalid_input');
    assert.equal((await errorOf(call(grant, { name: 'notes_archive_purge', input: null }, env))).kind, 'invalid_input');
    assert.equal((await errorOf(call(grant, null, env))).kind, 'invalid_input');
    assert.deepEqual(calls, []);
  });

  it('runs the action for the caller of the grant, with the accounts of its workspace', async () => {
    const asked: string[] = [];
    const perWorkspace = {
      async accounts(workspaceId: string) {
        asked.push(workspaceId);

        return [{ ...WORK, account: `work-of-${workspaceId}` }];
      },
      async secretsReady() {
        return true;
      },
    };
    const other = { workspaceId: 'workspace-2', threadId: 'thread-2', agentName: 'other' };
    const policy: GrantPolicy = { allows: () => true, actions: ['describe', 'call'] };
    const first = await computeGrant(catalog, policy, { caller: CALLER, connections: perWorkspace });
    const second = await computeGrant(catalog, policy, { caller: other, connections: perWorkspace });

    calls.length = 0;
    asked.length = 0;

    const input = (workspaceId: string) => ({ to: 'a@b.test', text: 'Hi', account: `work-of-${workspaceId}` });

    await invokeCapability(first, 'mail_send', input('workspace-1'), { connections: perWorkspace });
    await invokeCapability(second, 'mail_send', input('workspace-2'), { connections: perWorkspace });

    assert.deepEqual(
      calls.map(entry => entry.ctx.caller),
      [CALLER, other],
    );
    assert.deepEqual(
      calls.map(entry => entry.ctx.account?.account),
      ['work-of-workspace-1', 'work-of-workspace-2'],
    );
    assert.deepEqual(asked, ['workspace-1', 'workspace-2']);

    // An account of another workspace is not one of this caller's.
    const foreign = await errorOf(
      invokeCapability(first, 'mail_send', input('workspace-2'), { connections: perWorkspace }),
    );

    assert.equal(foreign.kind, 'not_found');

    const shown = await describeVertex(second, { name: 'mail' }, { connections: perWorkspace });

    assert.deepEqual(
      shown.accounts.map(account => account.account),
      ['work-of-workspace-2'],
    );
  });

  it('refuses a capability outside the grant before anything else, whatever the input', async () => {
    const grant = await grantOf({ allows: vertex => !['export_note', 'notes_archive'].includes(vertex.fullName) });

    calls.length = 0;

    const cutLeaf = await errorOf(invokeCapability(grant, 'export_note', { path: 'a.md' }, env));
    const cutNode = await errorOf(invokeCapability(grant, 'notes_archive_purge', {}, env));
    const typo = await errorOf(invokeCapability(grant, 'notes_lst', {}, env));
    const aNode = await errorOf(invokeCapability(grant, 'notes', {}, env));
    const theRoot = await errorOf(invokeCapability(grant, '', {}, env));

    assert.equal(cutLeaf.kind, 'unknown_capability');
    assert.equal(
      cutLeaf.message,
      'You have no capability `export_note`. Describe the root (no name) to see what you have.',
    );
    assert.equal(cutNode.kind, 'unknown_capability');
    assert.equal(
      typo.message,
      'You have no capability `notes_lst`. The nearest node you have is `notes`: describe it to see what is there.',
    );
    assert.equal(aNode.kind, 'unknown_capability');
    assert.match(aNode.message, /^`notes` is a node, not a capability\./);
    assert.equal(theRoot.kind, 'unknown_capability');
    assert.deepEqual(calls, []);
  });

  it('refuses an input that does not fit the type, naming what is wrong and carrying the signature', async () => {
    const grant = await grantOf();

    calls.length = 0;

    const error = await errorOf(invokeCapability(grant, 'notes_list', { limit: 500, status: null, page: 2 }, env));

    assert.equal(error.kind, 'invalid_input');
    assert.match(error.message, /^The input of `notes_list` does not fit its signature:\n/);
    assert.match(error.message, /\n- limit: Too big/);
    assert.match(error.message, /\n- status: Invalid option/);
    assert.match(error.message, /\n- Unrecognized key: "page"\n/);
    assert.match(error.message, /\nThe signature:\nnotes_list\(input: \{\n  status\?: "open" \| "done";/);
    assert.deepEqual(
      (error.details as { issues: Array<{ path: string }> }).issues.map(issue => issue.path),
      ['status', 'limit', ''],
    );
    assert.equal((await errorOf(invokeCapability(grant, 'notes_list', 'open', env))).kind, 'invalid_input');
    assert.deepEqual(calls, []);
  });

  it('checks the conditions between fields on the input as written', async () => {
    const grant = await grantOf();
    const error = await errorOf(invokeCapability(grant, 'notes_update', { id: 1 }, env));

    assert.equal(error.kind, 'invalid_input');
    assert.match(error.message, /\n- Pass at least one of: title, body \(got none\)\n/);
    assert.deepEqual(await invokeCapability(grant, 'notes_update', { id: 1, title: 'New' }, env), {
      id: 1,
      title: 'New',
      body: null,
      attachment: null,
    });
  });

  it('passes an error of the action through with its kind and details', async () => {
    const grant = await grantOf();
    const error = await errorOf(invokeCapability(grant, 'get_note', { id: 404 }, env));

    assert.deepEqual(error.toValue(), { kind: 'not_found', message: 'No note 404.', details: { id: 404 } });
  });

  it('turns any other exception of the action into internal', async () => {
    const grant = await grantOf();
    const error = await errorOf(invokeCapability(grant, 'get_note', { id: 500 }, env));

    assert.deepEqual(error.toValue(), { kind: 'internal', message: 'boom' });
  });

  it('turns a value that does not fit the output type into internal', async () => {
    const grant = await grantOf();
    const error = await errorOf(invokeCapability(grant, 'get_note', { id: 13 }, env));

    assert.equal(error.kind, 'internal');
    assert.match(error.message, /^`get_note` returned a value that does not fit its output type:\n- title: /);
  });

  it('resolves the account field and keeps it away from the action', async () => {
    const grant = await grantOf();

    calls.length = 0;

    assert.deepEqual(await invokeCapability(grant, 'mail_send', { to: 'a@b.test', text: 'Hi', account: 'work' }, env), {
      messageId: 'from-work',
    });
    assert.deepEqual(calls[0]?.input, { to: 'a@b.test', text: 'Hi' });
    assert.deepEqual(calls[0]?.ctx.account, WORK);
    assert.deepEqual(await invokeCapability(grant, 'mail_labels_list', { account: 'work' }, env), { labels: [] });
  });

  it('answers a missing, unknown or disconnected account without running the action', async () => {
    const grant = await grantOf();

    calls.length = 0;

    const missing = await errorOf(invokeCapability(grant, 'mail_send', { to: 'a@b.test', text: 'Hi' }, env));
    const unknown = await errorOf(
      invokeCapability(grant, 'mail_send', { to: 'a@b.test', text: 'Hi', account: 'home' }, env),
    );
    const expired = await errorOf(
      invokeCapability(grant, 'mail_send', { to: 'a@b.test', text: 'Hi', account: 'old' }, env),
    );

    assert.equal(missing.kind, 'invalid_input');
    assert.equal(
      missing.message,
      [
        'The input of `mail_send` does not fit its signature:',
        '- account: Pass the address of the account to act as. Accounts of "mail": work — "Work" (me@work.test), connected; old — "Old", reauthorization_required',
        'The signature:',
        'mail_send(input: {',
        '  to: string;',
        '  text: string;',
        '  account: string;  // The account to act as.',
        '}): {',
        '  messageId: string;',
        '}',
      ].join('\n'),
    );
    assert.deepEqual(
      (missing.details as { issues: Array<{ path: string }> }).issues.map(issue => issue.path),
      ['account'],
    );

    // Everything that does not fit is named at once, the platform's field
    // included.
    const both = await errorOf(invokeCapability(grant, 'mail_send', { to: 'a@b.test', account: 7 }, env));

    assert.deepEqual(
      (both.details as { issues: Array<{ path: string }> }).issues.map(issue => issue.path),
      ['text', 'account'],
    );
    assert.equal(unknown.kind, 'not_found');
    assert.match(unknown.message, /^No account "home" in "mail"\. Accounts of "mail": work/);
    assert.equal(expired.kind, 'auth_required');
    assert.deepEqual(calls, []);
  });

  it('does not take an account field outside an account connection', async () => {
    const grant = await grantOf();
    const error = await errorOf(invokeCapability(grant, 'search_query', { text: 'x', account: 'work' }, env));

    assert.equal(error.kind, 'invalid_input');
    assert.match(error.message, /Unrecognized key: "account"/);
  });

  it('turns a failure of the connections layer into a CapabilityError', async () => {
    const grant = await grantOf();
    const broken = {
      ...connections,
      async accounts(): Promise<never> {
        throw new Error('the connections store is down');
      },
    };
    const refused = {
      ...connections,
      async accounts(): Promise<never> {
        throw new CapabilityError('unavailable', 'The connections store gave no answer.');
      },
    };
    const input = { to: 'a@b.test', text: 'Hi', account: 'work' };

    calls.length = 0;

    assert.deepEqual((await errorOf(invokeCapability(grant, 'mail_send', input, { connections: broken }))).toValue(), {
      kind: 'internal',
      message: 'the connections store is down',
    });
    assert.equal(
      (await errorOf(call(grant, { name: 'mail_send', input }, { connections: refused }))).kind,
      'unavailable',
    );
    assert.deepEqual((await errorOf(describeVertex(grant, { name: 'mail' }, { connections: broken }))).toValue(), {
      kind: 'internal',
      message: 'the connections store is down',
    });
    assert.deepEqual(calls, []);
  });

  it('hands the signal of the caller to the action', async () => {
    const grant = await grantOf();
    const controller = new AbortController();

    calls.length = 0;
    await invokeCapability(grant, 'get_note', { id: 1 }, { ...env, signal: controller.signal });

    assert.equal(calls[0]?.ctx.signal, controller.signal);
  });
});

describe('the action call', () => {
  it('calls a capability by its full name', async () => {
    const grant = await grantOf();

    assert.deepEqual(await call(grant, { name: 'notes_archive_purge' }, env), { purged: 0 });
    assert.deepEqual(await call(grant, { name: 'get_note', input: { id: 7 } }, env), {
      id: 7,
      title: 'First',
      body: null,
      attachment: null,
    });
  });

  it('checks its own input and the grant', async () => {
    const grant = await grantOf({ allows: vertex => vertex.fullName !== 'export_note' });

    assert.equal((await errorOf(call(grant, { input: {} }, env))).kind, 'invalid_input');
    assert.equal(
      (await errorOf(call(grant, { name: 'export_note', input: { path: 'a.md' } }, env))).kind,
      'unknown_capability',
    );
  });
});

describe('the error of a call', () => {
  it('recognizes a CapabilityError of another copy of the class by its shape', () => {
    const foreign = Object.assign(new Error('Gone.'), {
      name: 'CapabilityError',
      kind: 'conflict',
      details: { state: 'done' },
    });

    assert.deepEqual(toCapabilityError(foreign).toValue(), {
      kind: 'conflict',
      message: 'Gone.',
      details: { state: 'done' },
    });
    assert.deepEqual(
      toCapabilityError(Object.assign(new Error('x'), { name: 'CapabilityError', kind: 'strange' })).toValue(),
      { kind: 'internal', message: 'x' },
    );
    assert.deepEqual(toCapabilityError('text').toValue(), { kind: 'internal', message: 'text' });
  });
});
