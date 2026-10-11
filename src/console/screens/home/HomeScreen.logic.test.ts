import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nothingRunningNote, offlineNote, sectionSummary } from './HomeScreen.logic.ts';
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
  facts: null,
  now: NOW,
  ...partial,
});

const GB = 1_000_000_000;
const FACTS: NonNullable<SectionCounts['facts']> = {
  machine: { uptimeSeconds: 1, cpu: { cores: 2, perCore: [10, 18], loadAvg: [0, 0, 0] }, memory: null, disk: { totalBytes: 200 * GB, usedBytes: 131 * GB, freeBytes: 69 * GB }, network: null },
  fileArea: { measuredAt: NOW, files: 2418, bytes: 1.2 * GB, folders: {}, complete: true, unreadable: 0 },
};

describe('home section summaries', () => {
  it('summarizes the sections from the snapshot counts', () => {
    assert.deepEqual(sectionSummary('threads', counts()), { meta: '4 active' });
    assert.deepEqual(sectionSummary('projects', counts()), { meta: '9 active · 3 archived' });
    assert.deepEqual(sectionSummary('apps', counts()), { meta: '5 · 2 published' });
    assert.deepEqual(sectionSummary('schedule', counts()), { meta: '7 tasks · next at 17:00' });
    assert.deepEqual(sectionSummary('connections', counts()), { meta: '3 accounts' });
    assert.deepEqual(sectionSummary('settings', counts()), { meta: 'names, Telegram, time zone' });
    assert.equal(sectionSummary('files', counts()), null);
    assert.equal(sectionSummary('system', counts()), null);
    assert.deepEqual(sectionSummary('files', counts({ facts: FACTS })), { meta: '2,418 files · 1.2 GB' });
    assert.deepEqual(sectionSummary('system', counts({ facts: FACTS })), { meta: 'CPU 14% · disk 66%' });
    assert.equal(sectionSummary('files', counts({ facts: { ...FACTS, fileArea: null } })), null);
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

  it('has no summary where the facts are not read yet, none for Home', () => {
    assert.equal(sectionSummary('files', counts()), null);
    assert.equal(sectionSummary('system', counts()), null);
    assert.equal(sectionSummary('home', counts()), null);
  });
});

describe('home words', () => {
  it('notes the last finished thread under "Nothing is running"', () => {
    assert.equal(nothingRunningNote(null, NOW), 'Threads appear here as agents start working.');
    assert.equal(nothingRunningNote({ title: 'Web UI: screens', agent: 'designer', updatedAt: at(2026, 10, 9, 16, 26) }, NOW), 'The last thread finished 12 min ago — “Web UI: screens”.');
    assert.equal(nothingRunningNote({ title: null, agent: 'gardener', updatedAt: at(2026, 10, 9, 16, 38) }, NOW), 'The last thread finished just now — “gardener”.');
  });

  it('names the moment the data is current up to while the tail is not flowing', () => {
    assert.equal(offlineNote(at(2026, 10, 9, 16, 31), NOW), 'No connection to the server. Data as of 16:31, reconnecting…');
    assert.equal(offlineNote(at(2026, 10, 8, 23, 50), NOW), 'No connection to the server. Data as of Oct 8, 23:50, reconnecting…');
    assert.equal(offlineNote(null, NOW), 'No connection to the server. The data on screen may be behind; reconnecting…');
  });
});
