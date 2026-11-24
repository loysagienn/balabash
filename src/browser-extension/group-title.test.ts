// How a session's group of tabs is named: by the start of its thread's
// title while it lives, as ended once it is over.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { endedTitle, groupTitle, startOf } from './group-title.ts';

describe('the title of a session’s group of tabs', () => {
  it('is the thread’s title when the title is short', () => {
    assert.equal(groupTitle('Order groceries'), 'Order groceries');
    assert.equal(groupTitle('  Renew   the policy '), 'Renew the policy');
  });

  it('keeps the first 20 characters of a longer title', () => {
    assert.equal(groupTitle('Find flights to Lisbon for March 12–19 and compare fares'), 'Find flights to Lisb…');
    assert.equal(groupTitle('Exactly twenty chars'), 'Exactly twenty chars');
    // No space is left hanging before the ellipsis.
    assert.equal(startOf('Collect the invoice s and more', 20), 'Collect the invoice…');
  });

  it('is the name of the service for a thread without a title', () => {
    assert.equal(groupTitle(''), 'Balabash');
    assert.equal(groupTitle('   '), 'Balabash');
  });
});

describe('the title of a group whose session ended', () => {
  it('says so before the title', () => {
    assert.equal(endedTitle('Order groceries'), 'Ended · Order groceries');
    assert.equal(endedTitle('Find flights to Lisb…'), 'Ended · Find flights to Lisb…');
  });

  it('stays what it is when applied twice, and says only that for a group without a title', () => {
    assert.equal(endedTitle('Balabash'), 'Ended · Balabash');
    assert.equal(endedTitle('Ended · Order groceries'), 'Ended · Order groceries');
    assert.equal(endedTitle(undefined), 'Ended ·');
  });
});
