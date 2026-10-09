import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { avatarVals } from './agents.ts';

describe('avatarVals', () => {
  it('maps the catalog agents to their fixed letter and identity color', () => {
    assert.deepEqual(avatarVals('engineer'), { letter: 'E', id: 1, title: 'engineer' });
    assert.deepEqual(avatarVals('coordinator'), { letter: 'C', id: 5, title: 'coordinator' });
    assert.deepEqual(avatarVals('power_point'), { letter: 'P', id: 3, title: 'power_point' });
    assert.deepEqual(avatarVals('you'), { letter: 'Y', id: 'you', title: 'you' });
  });

  it('gives an unknown agent its initial and no identity color', () => {
    assert.deepEqual(avatarVals('translator'), { letter: 'T', id: undefined, title: 'translator' });
    assert.deepEqual(avatarVals(''), { letter: '?', id: undefined, title: '' });
  });
});
