// The grant: the tree cut for one caller.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeGrant, grantedGuide, nearestNode, type GrantPolicy } from './grant.ts';
import { CALLER, OLD, WORK, testCatalog, testConnections } from './test-tree.ts';

const catalog = testCatalog();
const everything: GrantPolicy = { allows: () => true, actions: ['describe', 'run_program'] };
const connected = testConnections({ accounts: { mail: [WORK] }, secrets: ['search'] });

const grantOf = (policy: GrantPolicy, connections = connected) =>
  computeGrant(catalog, policy, { caller: CALLER, connections });

describe('the grant', () => {
  it('holds the whole tree for a policy that cuts nothing, with every connection in place', async () => {
    const grant = await grantOf(everything);

    assert.deepEqual([...grant.vertices], [...catalog.vertices.keys()]);
  });

  it('cuts the capabilities of the root one by one', async () => {
    const grant = await grantOf({ ...everything, allows: vertex => vertex.fullName !== 'export_note' });

    assert.equal(grant.vertices.has('get_note'), true);
    assert.equal(grant.vertices.has('export_note'), false);
  });

  it('never cuts a leaf below the root alone: the capabilities of a node come together', async () => {
    const asked: string[] = [];
    const grant = await grantOf({
      ...everything,
      allows: vertex => {
        asked.push(vertex.fullName);

        return vertex.fullName !== 'notes_list';
      },
    });

    assert.equal(grant.vertices.has('notes_list'), true);
    assert.equal(asked.includes('notes_list'), false);
    assert.deepEqual(asked, ['get_note', 'export_note', 'notes', 'notes_archive', 'mail', 'mail_labels', 'search']);
  });

  it('cuts a node with everything below it, and a sub-node apart from its parent', async () => {
    const withoutNotes = await grantOf({ ...everything, allows: vertex => vertex.fullName !== 'notes' });

    assert.deepEqual(
      [...withoutNotes.vertices].filter(name => name.startsWith('notes')),
      [],
    );

    const withoutArchive = await grantOf({ ...everything, allows: vertex => vertex.fullName !== 'notes_archive' });

    assert.deepEqual(
      [...withoutArchive.vertices].filter(name => name.startsWith('notes')),
      ['notes', 'notes_list', 'notes_update'],
    );
  });

  it('cuts a node whose account connection has no accounts', async () => {
    const none = await grantOf(everything, testConnections({ secrets: ['search'] }));
    const expired = await grantOf(everything, testConnections({ accounts: { mail: [OLD] }, secrets: ['search'] }));
    const one = await grantOf(everything, testConnections({ accounts: { mail: [OLD, WORK] }, secrets: ['search'] }));

    assert.equal(none.vertices.has('mail'), false);
    assert.equal(none.vertices.has('mail_labels_list'), false);
    assert.equal(expired.vertices.has('mail_send'), true);
    assert.equal(one.vertices.has('mail_send'), true);
  });

  it('cuts a node whose secret connection has no secrets', async () => {
    const grant = await grantOf(everything, testConnections({ accounts: { mail: [WORK] } }));

    assert.equal(grant.vertices.has('search'), false);
    assert.equal(grant.vertices.has('search_query'), false);
  });

  it('shows a recipe only when the caller has everything it requires', async () => {
    const full = await grantOf(everything);

    assert.deepEqual(grantedGuide(full, catalog.root), [
      'Open a vertex with `describe`.',
      'Leave an optional field out.',
      'Any note reads in full with `get_note`.',
      'A note becomes a file with `export_note`.',
    ]);

    const narrow = await grantOf({ allows: vertex => vertex.fullName !== 'get_note', actions: ['describe', 'call'] });
    const notes = catalog.vertices.get('notes');

    assert.ok(notes?.kind === 'node');
    assert.deepEqual(grantedGuide(narrow, catalog.root), [
      'Open a vertex with `describe`.',
      'Call an open capability through `call`.',
      'Leave an optional field out.',
      'A note becomes a file with `export_note`.',
    ]);
    assert.deepEqual(grantedGuide(narrow, notes), [
      'Find a note with `notes_list`, then change it with `notes_update`.',
    ]);
  });

  it('finds the deepest granted node on the path of a name', async () => {
    const grant = await grantOf({ ...everything, allows: vertex => vertex.fullName !== 'notes_archive' });

    assert.equal(nearestNode(grant, 'notes_lst').fullName, 'notes');
    assert.equal(nearestNode(grant, 'notes_archive_purge').fullName, 'notes');
    assert.equal(nearestNode(grant, 'mail_labels_get').fullName, 'mail_labels');
    assert.equal(nearestNode(grant, 'get_note').fullName, '');
    assert.equal(nearestNode(grant, 'nowhere').fullName, '');
  });
});
