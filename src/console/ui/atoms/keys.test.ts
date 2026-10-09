import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stepIndex } from './keys.ts';

describe('stepIndex', () => {
  it('moves along the axis and wraps around', () => {
    assert.equal(stepIndex('ArrowRight', 0, 3, 'x'), 1);
    assert.equal(stepIndex('ArrowRight', 2, 3, 'x'), 0);
    assert.equal(stepIndex('ArrowLeft', 0, 3, 'x'), 2);
    assert.equal(stepIndex('ArrowDown', 1, 3, 'y'), 2);
    assert.equal(stepIndex('ArrowUp', 0, 3, 'y'), 2);
  });

  it('jumps to the edges with Home and End', () => {
    assert.equal(stepIndex('Home', 2, 3, 'x'), 0);
    assert.equal(stepIndex('End', 0, 3, 'y'), 2);
  });

  it('enters the group from outside at the nearest edge', () => {
    assert.equal(stepIndex('ArrowDown', -1, 3, 'y'), 0);
    assert.equal(stepIndex('ArrowUp', -1, 3, 'y'), 2);
  });

  it('ignores the other axis, other keys and an empty group', () => {
    assert.equal(stepIndex('ArrowDown', 0, 3, 'x'), null);
    assert.equal(stepIndex('ArrowRight', 0, 3, 'y'), null);
    assert.equal(stepIndex('Enter', 0, 3, 'x'), null);
    assert.equal(stepIndex('ArrowRight', 0, 0, 'x'), null);
  });
});
