import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crumbsFromPath } from './Crumbs.logic.ts';

describe('crumbsFromPath', () => {
  it('splits a path into the clickable parts and the current one', () => {
    assert.deepEqual(crumbsFromPath('Files/balabash/design'), { parts: ['Files', 'balabash'], current: 'design' });
  });

  it('treats a single segment as current and drops empty segments', () => {
    assert.deepEqual(crumbsFromPath('Files'), { parts: [], current: 'Files' });
    assert.deepEqual(crumbsFromPath('Files/balabash/'), { parts: ['Files'], current: 'balabash' });
    assert.deepEqual(crumbsFromPath(''), { parts: [], current: '' });
  });
});
