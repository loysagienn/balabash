import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { threadCompletionFields, threadStartFields, threadStatusFrom } from './thread.ts';

describe('threadStatusFrom', () => {
  it('maps the three terminals and nothing else', () => {
    assert.equal(threadStatusFrom('thread.completed'), 'completed');
    assert.equal(threadStatusFrom('thread.failed'), 'failed');
    assert.equal(threadStatusFrom('thread.cancelled'), 'cancelled');
    assert.equal(threadStatusFrom('thread.cancel'), null);
    assert.equal(threadStatusFrom('thread.started'), null);
  });
});

describe('threadStartFields', () => {
  it('keeps agent, title and the project link; blanks become null', () => {
    assert.deepEqual(threadStartFields({ agent: 'engineer', title: 'Fix', projectId: 'p1', projectSlug: 'x', headless: true }), {
      agent: 'engineer',
      title: 'Fix',
      projectId: 'p1',
    });
    assert.deepEqual(threadStartFields({ agent: 'coordinator' }), { agent: 'coordinator', title: null, projectId: null });
    assert.deepEqual(threadStartFields({ agent: 'a', title: '  ', projectId: '' }), { agent: 'a', title: null, projectId: null });
  });
});

describe('threadCompletionFields', () => {
  it('returns only the fields the payload carries', () => {
    assert.deepEqual(threadCompletionFields({ summary: { text: 'done', fileIds: ['f'] }, title: ' New title ', description: 'd' }), {
      summary: { text: 'done', fileIds: ['f'] },
      title: 'New title',
      description: 'd',
    });
    assert.deepEqual(threadCompletionFields({ summary: { text: 'done' }, title: '' }), { summary: { text: 'done' } });
    assert.deepEqual(threadCompletionFields({}), {});
    assert.deepEqual(threadCompletionFields({ summary: 'not an object' }), {});
  });
});
