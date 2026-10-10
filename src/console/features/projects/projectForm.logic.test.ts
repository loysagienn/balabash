import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fieldOfFailure, projectMatches, projectPatch, slugFromTitle, validateProjectForm } from './projectForm.logic.ts';

describe('slugFromTitle', () => {
  it('derives a folder name from the title', () => {
    assert.equal(slugFromTitle('Bathroom renovation'), 'bathroom-renovation');
    assert.equal(slugFromTitle('  Vacation 2027 — Japan!  '), 'vacation-2027-japan');
    assert.equal(slugFromTitle('Ремонт ванной'), 'remont-vannoy');
    assert.equal(slugFromTitle('Щи & борщ'), 'shchi-borshch');
    assert.equal(slugFromTitle('Café Déjà vu'), 'cafe-deja-vu');
  });

  it('starts with a letter, never ends in a dash, fits the cap', () => {
    assert.equal(slugFromTitle('2027 plans'), 'plans');
    assert.equal(slugFromTitle('--- x ---'), 'x');
    assert.equal(slugFromTitle('42'), '');
    assert.equal(slugFromTitle('🙂'), '');

    const long = slugFromTitle(`${'a'.repeat(60)} bcdefg`);

    assert.equal(long.length, 64);
    assert.equal(long, `${'a'.repeat(60)}-bcd`);
    // The cut must not leave a dash at the end.
    assert.equal(slugFromTitle(`${'a'.repeat(63)} b`), 'a'.repeat(63));
  });
});

describe('validateProjectForm', () => {
  it('requires the name, the folder and the description on create', () => {
    assert.deepEqual(validateProjectForm({ title: ' ', slug: '', description: '' }, 'create'), {
      title: 'A name is required.',
      slug: 'A folder name is required.',
      description: 'A description is required — it is how agents match conversations to the project.',
    });
    assert.deepEqual(validateProjectForm({ title: 'Reno', slug: 'reno', description: 'd' }, 'create'), {});
  });

  it('checks the slug rule and the caps', () => {
    assert.equal(validateProjectForm({ title: 'R', slug: 'Reno', description: 'd' }, 'create').slug, 'Lowercase letters, digits and dashes, starting with a letter.');
    assert.equal(validateProjectForm({ title: 'R', slug: '1reno', description: 'd' }, 'create').slug, 'Lowercase letters, digits and dashes, starting with a letter.');
    assert.equal(validateProjectForm({ title: 'R', slug: 'a'.repeat(65), description: 'd' }, 'create').slug, 'At most 64 characters.');
    assert.equal(validateProjectForm({ title: 'x'.repeat(201), slug: 'r', description: 'd' }, 'create').title, 'At most 200 characters.');
    assert.equal(validateProjectForm({ title: 'R', slug: 'r', description: 'x'.repeat(2001) }, 'create').description, 'At most 2000 characters.');
  });

  it('leaves the slug alone on edit', () => {
    assert.deepEqual(validateProjectForm({ title: 'R', slug: 'Not A Slug', description: 'd' }, 'edit'), {});
    assert.equal(validateProjectForm({ title: '', slug: '', description: 'd' }, 'edit').title, 'A name is required.');
  });
});

describe('fieldOfFailure', () => {
  it('names the field a refusal is about, or none', () => {
    assert.equal(fieldOfFailure('title must be at most 200 chars'), 'title');
    assert.equal(fieldOfFailure('slug must match /^[a-z][a-z0-9-]*$/ and be at most 64 chars'), 'slug');
    assert.equal(fieldOfFailure('the path "x" in the workspace file area is taken by a file — pick another slug'), 'slug');
    assert.equal(fieldOfFailure('description must be at most 2000 chars'), 'description');
    assert.equal(fieldOfFailure('title "A" or slug "a" is already taken — check the projects list'), null);
    assert.equal(fieldOfFailure('Failed to fetch'), null);
  });
});

describe('projectPatch', () => {
  const base = { title: 'Reno', description: 'Apartment' };

  it('carries only what differs from the base, trimmed', () => {
    assert.equal(projectPatch(base, { title: ' Reno ', slug: 'reno', description: 'Apartment' }), null);
    assert.deepEqual(projectPatch(base, { title: 'Renovation', slug: 'reno', description: 'Apartment' }), { title: 'Renovation' });
    assert.deepEqual(projectPatch(base, { title: 'Reno', slug: 'reno', description: ' Flat ' }), { description: 'Flat' });
    assert.deepEqual(projectPatch(base, { title: 'A', slug: 'reno', description: 'B' }), { title: 'A', description: 'B' });
  });

  it('measures against the values the form opened with, not the row of the moment', () => {
    // The row was renamed from the tail while the dialog was open ("Before"
    // → "Renamed by event"); the operator changed only the description.
    const opened = { title: 'Before', description: 'old' };
    const values = { title: 'Before', slug: 'p', description: 'my description' };

    assert.deepEqual(projectPatch(opened, values), { description: 'my description' });
    // Against the renamed row the untouched title would have gone back.
    assert.deepEqual(projectPatch({ title: 'Renamed by event', description: 'old' }, values), { title: 'Before', description: 'my description' });
  });
});

describe('projectMatches', () => {
  const project = { title: 'Renovation', slug: 'reno-2026', description: 'Apartment on Petrogradsky' };

  it('looks through the name, the folder and the description, case aside', () => {
    assert.equal(projectMatches(project, undefined), true);
    assert.equal(projectMatches(project, '  '), true);
    assert.equal(projectMatches(project, 'RENO'), true);
    assert.equal(projectMatches(project, '2026'), true);
    assert.equal(projectMatches(project, 'petrograd'), true);
    assert.equal(projectMatches(project, 'yacht'), false);
  });
});
