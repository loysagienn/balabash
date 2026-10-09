// The pure edge of the project registry's changes: how the input of a
// creation and of an update is read (trimming, the required fields, the
// slug rule, the caps) and which refusal comes back — shared by the
// projects_* tools and the console's endpoints.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DESCRIPTION_MAX_LENGTH, ProjectError, SLUG_MAX_LENGTH, TITLE_MAX_LENGTH, parseProjectInput, parseProjectPatch } from './mutations.ts';

function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ProjectError, `expected a ProjectError, got ${String(error)}`);

    return { code: error.code, message: error.message };
  }

  assert.fail('expected a refusal');
}

describe('project input', () => {
  it('trims the fields and keeps them all', () => {
    assert.deepEqual(parseProjectInput({ title: '  Renovation ', slug: ' renovation ', description: ' The flat. ' }), {
      title: 'Renovation',
      slug: 'renovation',
      description: 'The flat.',
    });
  });

  it('requires a title, a slug by the rule and a description', () => {
    assert.equal(refusal(() => parseProjectInput({ title: ' ', slug: 'a', description: 'd' })).code, 'bad_request');
    assert.match(refusal(() => parseProjectInput({ slug: 'a', description: 'd' })).message, /title is required/);
    assert.match(refusal(() => parseProjectInput({ title: 't', slug: 'Bad Slug', description: 'd' })).message, /slug must match/);
    assert.match(refusal(() => parseProjectInput({ title: 't', slug: '1abc', description: 'd' })).message, /slug must match/);
    assert.match(refusal(() => parseProjectInput({ title: 't', slug: 'a'.repeat(SLUG_MAX_LENGTH + 1), description: 'd' })).message, /slug must match/);
    assert.match(refusal(() => parseProjectInput({ title: 't', slug: 'ok', description: 42 })).message, /description must be a string/);
    assert.match(refusal(() => parseProjectInput({ title: 't', slug: 'ok', description: null })).message, /description is required/);
    assert.match(refusal(() => parseProjectInput({ title: 't', slug: 'ok' })).message, /description is required/);
  });

  it('caps the title and the description', () => {
    assert.match(refusal(() => parseProjectInput({ title: 'x'.repeat(TITLE_MAX_LENGTH + 1), slug: 'ok', description: 'd' })).message, /title must be at most/);
    assert.match(refusal(() => parseProjectInput({ title: 't', slug: 'ok', description: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1) })).message, /description must be at most/);
    assert.equal(parseProjectInput({ title: 'x'.repeat(TITLE_MAX_LENGTH), slug: 'ok', description: 'd' }).title.length, TITLE_MAX_LENGTH);
  });
});

describe('project patch', () => {
  it('reads absent, null and blank fields as "keep"', () => {
    assert.deepEqual(parseProjectPatch({}), { title: null, description: null, slug: null });
    assert.deepEqual(parseProjectPatch({ title: null, description: '  ', slug: undefined }), { title: null, description: null, slug: null });
  });

  it('trims and checks the given fields', () => {
    assert.deepEqual(parseProjectPatch({ title: ' New ', description: null, slug: ' new-slug ' }), { title: 'New', description: null, slug: 'new-slug' });
    assert.match(refusal(() => parseProjectPatch({ slug: 'New' })).message, /slug must match/);
    assert.match(refusal(() => parseProjectPatch({ title: 'x'.repeat(TITLE_MAX_LENGTH + 1) })).message, /title must be at most/);
    assert.equal(refusal(() => parseProjectPatch({ description: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1) })).code, 'bad_request');
  });

  it('refuses a field of another type instead of reading it as "keep"', () => {
    assert.deepEqual(refusal(() => parseProjectPatch({ title: 5 })), { code: 'bad_request', message: 'title must be a string' });
    assert.match(refusal(() => parseProjectPatch({ title: 'T', slug: ['a'] })).message, /slug must be a string/);
    assert.match(refusal(() => parseProjectPatch({ description: {} })).message, /description must be a string/);
    assert.match(refusal(() => parseProjectPatch({ title: 'T', description: false })).message, /description must be a string/);
  });
});
