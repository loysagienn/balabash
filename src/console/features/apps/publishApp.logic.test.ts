import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeSlug, publishFailureUnderField, slugError, slugTakenBy, suggestedSlug, takenWords, unpublishWords } from './publishApp.logic.ts';

const APPS = [
  { name: 'Calorie tracker', description: null, path: 'apps/kcal', slug: 'kcal', manifestError: null },
  { name: 'Renovation checklist', description: null, path: 'renovation/app', slug: null, manifestError: null },
  { name: null, description: null, path: 'apps/wind', slug: 'wind', manifestError: 'bad' },
];

describe('publish dialog rules', () => {
  it('suggests a slug from the name, else from the folder', () => {
    assert.equal(suggestedSlug({ name: 'Renovation checklist', path: 'renovation/app' }), 'renovation-checklist');
    assert.equal(suggestedSlug({ name: 'Трекер калорий', path: 'apps/kcal' }), 'treker-kaloriy');
    assert.equal(suggestedSlug({ name: null, path: 'apps/wind-2' }), 'wind-2');
    assert.equal(suggestedSlug({ name: '🙂', path: 'apps/kcal' }), 'kcal');
    assert.equal(suggestedSlug({ name: `${'a'.repeat(63)} b`, path: 'x' }), 'a'.repeat(63));
  });

  it('normalizes what the operator typed the way the server stores it', () => {
    assert.equal(normalizeSlug('  Kcal '), 'kcal');
  });

  it('checks the slug by the server rule and the reserved names', () => {
    assert.equal(slugError('kcal'), null);
    assert.equal(slugError('2027'), null);
    assert.equal(slugError('a'), null);
    assert.equal(slugError('a'.repeat(64)), null);
    assert.equal(slugError(''), 'A URL is required.');
    assert.match(slugError('-kcal') ?? '', /dash/);
    assert.match(slugError('kcal-') ?? '', /dash/);
    assert.match(slugError('k cal') ?? '', /Lowercase/);
    assert.match(slugError('a'.repeat(65)) ?? '', /64/);
    assert.equal(slugError('apps'), '“apps” is a reserved name — pick another URL.');
    assert.match(slugError('auth') ?? '', /reserved/);
  });

  it('knows a slug another app of the workspace holds', () => {
    assert.equal(slugTakenBy(APPS, 'kcal', 'renovation/app'), APPS[0]);
    assert.equal(slugTakenBy(APPS, 'kcal', 'apps/kcal'), null);
    assert.equal(slugTakenBy(APPS, 'reno', 'renovation/app'), null);
    assert.equal(takenWords(APPS[0]), 'URL already taken by “Calorie tracker”');
    assert.equal(takenWords(APPS[2]), 'URL already taken by “wind”');
  });

  it('puts a refusal about the slug under the field, the rest above the form', () => {
    assert.equal(publishFailureUnderField('The slug "kcal" is taken — pick another one'), true);
    assert.equal(publishFailureUnderField('slug must be 1–64 chars of [a-z0-9-], not starting or ending with "-"'), true);
    assert.equal(publishFailureUnderField('Already published as "kcal" — unpublish first to change the slug'), true);
    assert.equal(publishFailureUnderField('The app\'s manifest is broken — fix it before publishing: name is required'), false);
    assert.equal(publishFailureUnderField('apps/x is not an app: no balabash-app.json there'), false);
  });

  it('words the unpublish question', () => {
    assert.equal(unpublishWords('apps.example/kcal'), 'The link apps.example/kcal will stop working, and the URL becomes free for any app.');
  });
});
