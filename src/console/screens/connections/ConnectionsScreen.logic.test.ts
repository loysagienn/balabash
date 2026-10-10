// The words of the Connections screen: the badge over the status, the
// meta line, the scopes, the row's action over the status and a held
// link, the catalog's counts and whether a service takes another account,
// the checks of the forms.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConnectionView, ServiceView } from '../../../api/contract.ts';
import { accountMeta, canConnect, catalogCount, linkAlive, nameHint, nameRequired, objState, pendingWords, rowAction, scopeList, serviceIcon, statusWords, validateConnectName, validateRename } from './ConnectionsScreen.logic.ts';

const NOW = new Date(2026, 9, 10, 22, 30);

function connection(patch: Partial<ConnectionView> = {}): ConnectionView {
  return { id: 'c1', server: 'notion', accountKey: 'work', displayName: 'Work', status: 'connected', identity: 'v@example.com', scope: 'read_content update_content', threadId: null, createdAt: new Date(2026, 8, 3, 10, 0), updatedAt: new Date(2026, 9, 10, 21, 0), ...patch };
}

const service = (patch: Partial<ServiceView> = {}): ServiceView => ({ name: 'notion', description: 'Pages and databases', multiAccount: true, manualClient: false, ...patch });

describe('status words', () => {
  it('maps the three statuses to the palette and shows an unknown one as it is', () => {
    assert.deepEqual(statusWords('connected'), { state: 'done', label: 'connected' });
    assert.deepEqual(statusWords('pending'), { state: 'wait', label: 'pending' });
    assert.deepEqual(statusWords('reauthorization_required'), { state: 'act', label: 'needs sign-in' });
    assert.deepEqual(statusWords('frozen'), { state: 'off', label: 'frozen' });
    assert.equal(objState('connected'), undefined);
    assert.equal(objState('pending'), 'wait');
  });

  it('picks the service icon by name', () => {
    assert.equal(serviceIcon('notion'), 'book-open');
    assert.equal(serviceIcon('gmail'), 'mail');
    assert.equal(serviceIcon('google-calendar'), 'calendar');
    assert.equal(serviceIcon('github'), 'git-fork');
    assert.equal(serviceIcon('yandex-direct'), 'plug');
  });
});

describe('the row', () => {
  it('meta: service, identity or address, since when; a pending row names its link', () => {
    assert.equal(accountMeta(connection(), NOW), 'notion · v@example.com · since Sep 3');
    assert.equal(accountMeta(connection({ identity: null }), NOW), 'notion · work · since Sep 3');
    assert.equal(accountMeta(connection({ status: 'pending', identity: null }), NOW), 'notion · work · link issued 21:00');
    assert.equal(accountMeta(connection({ createdAt: new Date(2025, 7, 12) }), NOW), 'notion · v@example.com · since Aug 12, 2025');
  });

  it('scopes split on whitespace and commas', () => {
    assert.deepEqual(scopeList('read_content update_content'), ['read_content', 'update_content']);
    assert.deepEqual(scopeList('gmail.readonly, gmail.send'), ['gmail.readonly', 'gmail.send']);
    assert.deepEqual(scopeList(null), []);
    assert.deepEqual(scopeList('  '), []);
  });

  it('the action: a live link is opened, an expired one is not; sign-in and a new link by status; none for a connected account', () => {
    const live = { url: 'https://b.example/connect/notion?nonce=1', expiresAt: new Date(NOW.getTime() + 60_000), issuedAt: NOW };
    const dead = { ...live, expiresAt: new Date(NOW.getTime() - 1) };

    assert.equal(linkAlive(live, NOW), true);
    assert.equal(linkAlive(dead, NOW), false);
    assert.equal(linkAlive(null, NOW), false);
    assert.deepEqual(rowAction(connection(), live, NOW), { kind: 'open', label: 'Open sign-in', url: live.url });
    assert.deepEqual(rowAction(connection({ status: 'reauthorization_required' }), dead, NOW), { kind: 'reconnect', label: 'Sign in' });
    assert.deepEqual(rowAction(connection({ status: 'pending' }), null, NOW), { kind: 'reconnect', label: 'New link' });
    assert.equal(rowAction(connection(), null, NOW), null);
  });

  it('a pending account explains itself by whether this tab holds its link', () => {
    const live = { url: 'u', expiresAt: new Date(NOW.getTime() + 60_000), issuedAt: NOW };

    assert.match(pendingWords(connection({ status: 'pending' }), live, NOW) ?? '', /^Sign in at notion to finish/);
    assert.match(pendingWords(connection({ status: 'pending' }), null, NOW) ?? '', /^Sign-in not finished/);
    assert.equal(pendingWords(connection(), null, NOW), null);
  });
});

describe('the catalog', () => {
  it('counts accounts and knows which service takes another', () => {
    assert.equal(catalogCount(0), 'not connected');
    assert.equal(catalogCount(1), '1 account');
    assert.equal(catalogCount(3), '3 accounts');
    assert.equal(canConnect(service(), 2), true);
    assert.equal(canConnect(service({ multiAccount: false }), 0), true);
    assert.equal(canConnect(service({ multiAccount: false }), 1), false);
  });

  it('the name of a new account is optional for the first one and required after it', () => {
    assert.equal(nameRequired(service(), 0), false);
    assert.equal(nameRequired(service(), 1), true);
    assert.equal(nameRequired(service({ multiAccount: false }), 0), false);
    assert.match(nameHint(service(), 0), /Optional — “notion” when empty/);
    assert.match(nameHint(service(), 2), /already has 2 accounts/);
    assert.equal(validateConnectName('  ', false), null);
    assert.equal(validateConnectName('  ', true), 'Required.');
    assert.equal(validateConnectName('x'.repeat(201), false), 'At most 200 characters.');
    assert.equal(validateRename(' '), 'Required.');
    assert.equal(validateRename('Personal'), null);
  });
});
