// The installation services of the connections layer: one list over every
// source, one entry per name.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSecretService,
  listSecretServices,
  refreshSecretServices,
  registerSecretServiceSource,
  type SecretService,
} from './services.ts';

const service = (name: string, description: string, connected = false): SecretService => ({
  name,
  description,
  secretNames: ['API_KEY'],
  connected,
  error: null,
});

test('a service two sources name is listed once, as the source registered later defines it', async () => {
  const heard: string[] = [];
  let entered = false;

  registerSecretServiceSource({
    list: () => [service('search', 'a tool server'), service('tracker', 'a tool server')],
    refresh: async () => {},
  });
  registerSecretServiceSource({
    list: () => [service('search', 'a node of the tree', entered)],
    refresh: async () => {
      heard.push('refresh');
      entered = !entered;
    },
  });

  assert.deepEqual(
    listSecretServices().map(({ name, description, connected }) => [name, description, connected]),
    [
      ['search', 'a node of the tree', false],
      ['tracker', 'a tool server', false],
    ],
  );

  await refreshSecretServices();
  assert.equal(getSecretService('search')?.connected, true);
  assert.equal(getSecretService('wiki'), null);

  await refreshSecretServices();
  assert.deepEqual(heard, ['refresh', 'refresh']);
  assert.equal(getSecretService('search')?.connected, false);
});
