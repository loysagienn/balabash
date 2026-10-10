import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeSlug, publicationDialog, publishFailureUnderField, slugError, slugTakenBy, suggestedSlug, takenWords, unpublishWords } from './publishApp.logic.ts';
import type { PublicationDialog } from './publishApp.logic.ts';

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
    assert.equal(publishFailureUnderField('"apps" is a reserved name — pick another slug'), true);
    assert.equal(publishFailureUnderField('Already published as "kcal"'), true);
    // The word "slug" inside the folder's path or the manifest's details is not a refusal about the field.
    assert.equal(publishFailureUnderField('apps/slug-demo is not an app: no balabash-app.json there'), false);
    assert.equal(publishFailureUnderField('The app\'s manifest is broken — fix it before publishing: unknown key "slug"'), false);
    assert.equal(publishFailureUnderField('Invalid path'), false);
  });

  it('words the unpublish question', () => {
    assert.equal(unpublishWords('apps.example/kcal'), 'The link apps.example/kcal will stop working, and the URL becomes free for any app.');
  });

  it('shows the chosen publication dialog only while the row still calls for it', () => {
    assert.equal(publicationDialog('publish', false), 'publish');
    assert.equal(publicationDialog('publish', true), null);
    assert.equal(publicationDialog('unpublish', true), 'unpublish');
    assert.equal(publicationDialog('unpublish', false), null);
    assert.equal(publicationDialog(null, true), null);
    assert.equal(publicationDialog(null, false), null);
  });

  it('lifecycle: the menu forgets a dialog whose offer ended, so the publication changing back does not bring it back', () => {
    // The menu's state and the row's publication, scripted the way AppMenu
    // runs them: `shown` is derived on every render, a chosen dialog no
    // longer shown is forgotten (the effect).
    let chosen: PublicationDialog = null;
    const render = (slug: string | null) => {
      const shown = publicationDialog(chosen, slug !== null);

      if (chosen !== null && shown === null) {
        chosen = null;
      }

      return shown;
    };

    // All segment, a published row: "Unpublish…" chosen, the Confirm is up.
    chosen = 'unpublish';
    assert.equal(render('kcal'), 'unpublish');
    // The unpublish succeeded: the row has no address — the Confirm is gone and the choice with it.
    assert.equal(render(null), null);
    assert.equal(chosen, null);
    // The publication comes back (another tab, an agent): no Confirm appears by itself.
    assert.equal(render('kcal'), null);

    // The mirror: "Publish…" chosen on an unpublished row; the row gets published (the call's answer, the tail): the dialog is over.
    chosen = 'publish';
    assert.equal(render(null), 'publish');
    assert.equal(render('kcal'), null);
    assert.equal(chosen, null);
    assert.equal(render(null), null);
  });
});
