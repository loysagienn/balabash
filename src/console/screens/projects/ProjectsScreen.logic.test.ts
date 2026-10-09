import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchesElsewhere, nothingFoundWords, projectsCounts, visibleProjects, withProjectsFilters } from './ProjectsScreen.logic.ts';

const at = (iso: string) => new Date(iso);
const PROJECTS = [
  { title: 'Renovation', slug: 'renovation', description: 'Apartment', archived: false, updatedAt: at('2026-10-09T10:00:00Z') },
  { title: 'Balabash', slug: 'balabash', description: 'The assistant itself', archived: false, updatedAt: at('2026-10-09T12:00:00Z') },
  { title: 'Old blog', slug: 'old-blog', description: 'Archived with its drafts', archived: true, updatedAt: at('2026-08-02T10:00:00Z') },
];

describe('projects screen', () => {
  it('counts the segments', () => {
    assert.deepEqual(projectsCounts(PROJECTS), { active: 2, archived: 1 });
    assert.deepEqual(projectsCounts([]), { active: 0, archived: 0 });
  });

  it('shows the segment, most recently worked on first, narrowed by the search', () => {
    assert.deepEqual(visibleProjects(PROJECTS, { key: 'projects' }).map(p => p.slug), ['balabash', 'renovation']);
    assert.deepEqual(visibleProjects(PROJECTS, { key: 'projects', archived: true }).map(p => p.slug), ['old-blog']);
    assert.deepEqual(visibleProjects(PROJECTS, { key: 'projects', q: 'apart' }).map(p => p.slug), ['renovation']);
    assert.deepEqual(visibleProjects(PROJECTS, { key: 'projects', q: 'blog' }), []);
    assert.equal(matchesElsewhere(PROJECTS, { key: 'projects', q: 'blog' }), 1);
    assert.equal(matchesElsewhere(PROJECTS, { key: 'projects', archived: true, q: 'a' }), 2);
  });

  it('keeps the route canonical', () => {
    assert.deepEqual(withProjectsFilters({ key: 'projects' }, { archived: true }), { key: 'projects', archived: true });
    assert.deepEqual(withProjectsFilters({ key: 'projects', archived: true, q: 'x' }, { archived: false }), { key: 'projects', q: 'x' });
    assert.deepEqual(withProjectsFilters({ key: 'projects', q: 'x' }, { q: '' }), { key: 'projects' });
  });

  it('says where the matches are', () => {
    assert.equal(nothingFoundWords('yacht', false, 0), 'No projects with “yacht” in the name, folder or description. None in the archive either.');
    assert.equal(nothingFoundWords('blog', false, 1), 'No projects with “blog” in the name, folder or description. 1 in the archive.');
    assert.equal(nothingFoundWords('reno', true, 1), 'No archived projects with “reno” in the name, folder or description. 1 among the active projects.');
  });
});
