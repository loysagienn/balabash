import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allThreadsLabel, emptyProjectThreads, pinsOf, projectRoute, projectShell, projectStage } from './ProjectScreen.logic.ts';

describe('project page', () => {
  it('tells the stage of the page', () => {
    assert.equal(projectStage(false, 'loading'), 'loading');
    assert.equal(projectStage(false, 'failed'), 'failed');
    assert.equal(projectStage(false, 'ready'), 'unknown');
    assert.equal(projectStage(true, 'ready'), 'project');
  });

  it('names the link to all project threads with their count once known', () => {
    assert.equal(allThreadsLabel(null), 'All');
    assert.equal(allThreadsLabel(0), 'All · 0');
    assert.equal(allThreadsLabel(1234), 'All · 1,234');
  });

  it('tells a project without threads from one whose threads are older than the window', () => {
    assert.deepEqual(emptyProjectThreads(0), { title: 'No threads yet', note: 'Threads started for this project appear here as agents work on it.' });
    assert.deepEqual(emptyProjectThreads(1), { title: 'No recent threads', note: 'The project has 1 thread, all older than the recent ones shown here; they are under All.' });
    assert.deepEqual(emptyProjectThreads(1234), { title: 'No recent threads', note: 'The project has 1,234 threads, all older than the recent ones shown here; they are under All.' });
    assert.deepEqual(emptyProjectThreads(null), { title: 'No recent threads', note: 'Nothing recent for this project; its earlier threads are under All.' });
  });

  it('routes the file area at the project folder', () => {
    assert.deepEqual(projectRoute('reno', 'reno'), { key: 'project', slug: 'reno' });
    assert.deepEqual(projectRoute('reno', 'reno/'), { key: 'project', slug: 'reno' });
    assert.deepEqual(projectRoute('reno', 'reno/docs'), { key: 'project', slug: 'reno', path: 'docs' });
    assert.deepEqual(projectRoute('reno', 'reno/docs/a.md'), { key: 'project', slug: 'reno', path: 'docs/a.md' });
  });

  it('shapes the shell by the path inside the folder', () => {
    assert.deepEqual(projectShell('Renovation', 'reno', undefined, null), {
      title: 'Renovation',
      crumb: { label: 'Projects', route: { key: 'projects' } },
      back: { key: 'projects' },
      detail: false,
      pageHead: true,
    });
    assert.deepEqual(projectShell('Renovation', 'reno', 'docs', 'dir').back, { key: 'project', slug: 'reno' });
    assert.equal(projectShell('Renovation', 'reno', 'docs', 'dir').titleNarrow, 'docs');
    assert.equal(projectShell('Renovation', 'reno', 'docs/deep', null).detail, false);
    assert.deepEqual(projectShell('Renovation', 'reno', 'docs/deep', null).back, { key: 'project', slug: 'reno', path: 'docs' });

    const file = projectShell('Renovation', 'reno', 'docs/a.md', 'file');

    assert.equal(file.detail, true);
    assert.equal(file.titleNarrow, 'a.md');
    assert.deepEqual(file.back, { key: 'project', slug: 'reno', path: 'docs' });
  });

  it('pins the files the folder has', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const files = [
      { path: 'reno/AGENTS.md', modifiedAt: '2026-10-08T12:00:00Z' },
      { path: 'reno/journal.md', modifiedAt: null },
      { path: 'reno/notes.md', modifiedAt: '2026-10-09T10:00:00Z' },
    ];

    assert.deepEqual(pinsOf('reno', files, now), [
      { icon: 'pin', name: 'AGENTS.md', desc: 'entry · updated yesterday', path: 'reno/AGENTS.md' },
      { icon: 'history', name: 'journal.md', desc: 'journal', path: 'reno/journal.md' },
    ]);
    assert.deepEqual(pinsOf('reno', [], now), []);
  });
});
