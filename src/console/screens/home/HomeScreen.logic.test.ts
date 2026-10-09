import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nothingRunningNote, sectionSummary } from './HomeScreen.logic.ts';
import type { SectionCounts } from './HomeScreen.logic.ts';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const NOW = at(2026, 10, 9, 16, 38);

const counts = (partial: Partial<SectionCounts> = {}): SectionCounts => ({
  running: 4,
  projects: 12,
  archivedProjects: 3,
  apps: 5,
  publishedApps: 2,
  tasks: 7,
  nextRunAt: at(2026, 10, 9, 17, 0),
  connections: 3,
  connectionsNeedingAction: 0,
  agents: 11,
  now: NOW,
  ...partial,
});

describe('home section summaries', () => {
  it('summarizes the sections from the snapshot counts', () => {
    assert.deepEqual(sectionSummary('threads', counts()), { meta: '4 active' });
    assert.deepEqual(sectionSummary('projects', counts()), { meta: '9 active · 3 archived' });
    assert.deepEqual(sectionSummary('apps', counts()), { meta: '5 · 2 published' });
    assert.deepEqual(sectionSummary('schedule', counts()), { meta: '7 tasks · next at 17:00' });
    assert.deepEqual(sectionSummary('connections', counts()), { meta: '3 accounts' });
    assert.deepEqual(sectionSummary('agents', counts()), { meta: '11 agents' });
  });

  it('colors only what awaits action', () => {
    assert.deepEqual(sectionSummary('connections', counts({ connectionsNeedingAction: 1 })), { meta: '1 needs sign-in', state: 'act' });
    assert.deepEqual(sectionSummary('connections', counts({ connectionsNeedingAction: 2 })), { meta: '2 need sign-in', state: 'act' });
  });

  it('explains empty sections and a next run on another day', () => {
    assert.deepEqual(sectionSummary('threads', counts({ running: 0 })), { meta: '0 active' });
    assert.deepEqual(sectionSummary('projects', counts({ projects: 0, archivedProjects: 0 })), { meta: 'none yet' });
    assert.deepEqual(sectionSummary('projects', counts({ projects: 2, archivedProjects: 0 })), { meta: '2 active' });
    assert.deepEqual(sectionSummary('apps', counts({ apps: 0, publishedApps: 0 })), { meta: 'none yet' });
    assert.deepEqual(sectionSummary('schedule', counts({ tasks: 0, nextRunAt: null })), { meta: 'no tasks' });
    assert.deepEqual(sectionSummary('schedule', counts({ tasks: 1, nextRunAt: null })), { meta: '1 task' });
    assert.deepEqual(sectionSummary('schedule', counts({ nextRunAt: at(2026, 10, 10, 9, 0) })), { meta: '7 tasks · next Oct 10, 09:00' });
    assert.deepEqual(sectionSummary('connections', counts({ connections: 0 })), { meta: 'none yet' });
  });

  it('has no summary where the data does not exist yet', () => {
    assert.equal(sectionSummary('files', counts()), null);
    assert.equal(sectionSummary('system', counts()), null);
    assert.equal(sectionSummary('settings', counts()), null);
    assert.equal(sectionSummary('home', counts()), null);
  });
});

describe('home words', () => {
  it('notes the last finished thread under "Nothing is running"', () => {
    assert.equal(nothingRunningNote(null, NOW), 'Threads appear here as agents start working.');
    assert.equal(nothingRunningNote({ title: 'Web UI: screens', agent: 'designer', updatedAt: at(2026, 10, 9, 16, 26) }, NOW), 'The last thread finished 12 min ago — “Web UI: screens”.');
    assert.equal(nothingRunningNote({ title: null, agent: 'gardener', updatedAt: at(2026, 10, 9, 16, 38) }, NOW), 'The last thread finished just now — “gardener”.');
  });
});
