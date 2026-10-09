import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isActiveState, threadRowMeta } from './ThreadRow.logic.ts';

describe('isActiveState', () => {
  it('counts the three session states as live', () => {
    assert.equal(isActiveState('run'), true);
    assert.equal(isActiveState('wait'), true);
    assert.equal(isActiveState('act'), true);
    assert.equal(isActiveState('done'), false);
    assert.equal(isActiveState('err'), false);
    assert.equal(isActiveState('off'), false);
  });
});

describe('threadRowMeta', () => {
  it('lists agent, headless tag, project, children and the last command', () => {
    assert.deepEqual(threadRowMeta({ agent: 'engineer', headless: true, project: 'Balabash', kids: 2, lastCode: 'npm run build' }), [
      { kind: 'text', text: 'engineer' },
      { kind: 'tag', text: 'headless' },
      { kind: 'text', text: 'Balabash' },
      { kind: 'kids', text: '2 children' },
      { kind: 'code', text: 'npm run build' },
    ]);
  });

  it('skips what is missing, hides the agent on its own page and prefers the command over text', () => {
    assert.deepEqual(threadRowMeta({ agent: 'engineer', noAgent: true, kids: 1, last: 'Thinking' }), [
      { kind: 'kids', text: '1 child' },
      { kind: 'text', text: 'Thinking' },
    ]);
    assert.deepEqual(threadRowMeta({ agent: 'manager', last: 'Thinking', lastCode: 'Read a.ts' }), [
      { kind: 'text', text: 'manager' },
      { kind: 'code', text: 'Read a.ts' },
    ]);
    assert.deepEqual(threadRowMeta({ agent: 'manager', kids: 0 }), [{ kind: 'text', text: 'manager' }]);
  });
});
