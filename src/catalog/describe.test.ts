// The action `describe`: the value it gives for a node and for a capability.

import assert from 'node:assert/strict';
import { describe as suite, it } from 'node:test';
import { describe } from './describe.ts';
import { CapabilityError } from './errors.ts';
import { computeGrant, type GrantPolicy } from './grant.ts';
import { OLD, WORK, testCatalog, testConnections } from './test-tree.ts';

const catalog = testCatalog();
const connections = testConnections({ accounts: { mail: [WORK, OLD] }, secrets: ['search'] });
const env = { connections };
const grantOf = (policy: Partial<GrantPolicy> = {}) =>
  computeGrant(
    catalog,
    { allows: () => true, actions: ['describe', 'run_program'], ...policy },
    { workspaceId: 'workspace-1', connections },
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

suite('describe', () => {
  it('shows the root without a name: the guide the caller can follow and one line per granted child', async () => {
    const grant = await grantOf({ allows: vertex => !['export_note', 'search'].includes(vertex.fullName) });

    assert.deepEqual(await describe(grant, {}, env), {
      kind: 'node',
      name: '',
      summary: 'Everything the test platform can do.',
      guide: [
        'Open a vertex with `describe`.',
        'Leave an optional field out.',
        'Any note reads in full with `get_note`.',
      ],
      accounts: [],
      children: [
        { kind: 'capability', name: 'get_note', summary: 'Load one note by its id' },
        { kind: 'node', name: 'notes', summary: 'The notes of the workspace. Come here to find or change a note.' },
        { kind: 'node', name: 'mail', summary: "The user's mail. Come here to send a letter." },
      ],
    });
    assert.deepEqual(await describe(grant, undefined, env), await describe(grant, {}, env));
  });

  it('shows a node with the accounts of its connection, whatever their status', async () => {
    const grant = await grantOf();
    const mail = await describe(grant, { name: 'mail' }, env);
    const labels = await describe(grant, { name: 'mail_labels' }, env);

    assert.ok(mail.kind === 'node');
    assert.deepEqual(mail.accounts, [WORK, OLD]);
    assert.deepEqual(mail.children, [
      { kind: 'capability', name: 'mail_send', summary: 'Send a plain-text letter' },
      { kind: 'node', name: 'mail_labels', summary: 'The labels of the mailbox.' },
    ]);
    assert.ok(labels.kind === 'node');
    assert.deepEqual(labels.accounts, [WORK, OLD]);
  });

  it('shows a capability: the description, the signature, the named types of the signature, the accounts', async () => {
    const grant = await grantOf();

    assert.deepEqual(await describe(grant, { name: 'notes_update' }, env), {
      kind: 'capability',
      name: 'notes_update',
      description: 'Change a note. Fields left out stay as they are.',
      signature: [
        'notes_update(input: {',
        '  // at least one of: title, body',
        '  id: number;  // [integer]',
        '  title?: string;  // [1..80 chars]',
        '  body?: string;  // Markdown.',
        '}): TestNote',
      ].join('\n'),
      types: [
        [
          '/** One note of the test tree. */',
          'type TestNote = {',
          '  id: number;',
          '  title: string;',
          '  body: string | null;  // null for an empty note.',
          '  attachment: FileRef | null;',
          '};',
        ].join('\n'),
        [
          '/** Reference to a file in Balabash storage: the form a file takes in an output. Identity and metadata, never content. */',
          'type FileRef = {',
          '  kind: "file";  // Marks a file inside any value.',
          '  id: FileId;',
          '  name: string | null;',
          '  contentType: string | null;  // MIME type.',
          '  sizeBytes: number | null;',
          '  width: number | null;  // Pixels; images only.',
          '  height: number | null;  // Pixels; images only.',
          '};',
        ].join('\n'),
        '/** Id of a file in Balabash storage: the form a file takes in an input. */\ntype FileId = string;',
      ],
      accounts: [],
    });

    const send = await describe(grant, { name: 'mail_send' }, env);

    assert.ok(send.kind === 'capability');
    assert.deepEqual(send.accounts, [WORK, OLD]);
    assert.deepEqual(send.types, []);
  });

  it('answers a name the caller does not have with not_found and the nearest node', async () => {
    const grant = await grantOf({ allows: vertex => vertex.fullName !== 'notes_archive' });
    const typo = await errorOf(describe(grant, { name: 'notes_lst' }, env));
    const cut = await errorOf(describe(grant, { name: 'notes_archive_purge' }, env));
    const nowhere = await errorOf(describe(grant, { name: 'nowhere' }, env));
    const action = await errorOf(describe(grant, { name: 'run_program' }, env));

    assert.equal(typo.kind, 'not_found');
    assert.equal(
      typo.message,
      'You have no vertex `notes_lst`. The nearest node you have is `notes`: describe it to see what is there.',
    );
    assert.equal(cut.kind, 'not_found');
    assert.match(cut.message, /The nearest node you have is `notes`/);
    assert.equal(nowhere.message, 'You have no vertex `nowhere`. Describe the root (no name) to see what you have.');
    assert.equal(action.kind, 'not_found');
  });

  it('checks its own input like any capability', async () => {
    const grant = await grantOf();
    const error = await errorOf(describe(grant, { vertex: 'notes' }, env));

    assert.equal(error.kind, 'invalid_input');
    assert.match(
      error.message,
      /The input of `describe` does not fit its signature:\n- Unrecognized key: "vertex"\nThe signature:\ndescribe\(input: \{/,
    );
  });
});
