// The totals of a file area (src/workspace/totals.ts): every regular file
// counted with its bytes, per top-level folder too; a hidden file counts,
// a symbolic link does not; a missing directory is no measurement.
//
// Run: npm test

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { measureDirectory } from './totals.ts';

let dir: string;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'balabash-totals-'));
  await fs.mkdir(path.join(dir, 'renovation', 'photos'), { recursive: true });
  await fs.mkdir(path.join(dir, 'empty'));
  await fs.writeFile(path.join(dir, 'notes.md'), 'abc');
  await fs.writeFile(path.join(dir, '.hidden'), 'hidden');
  await fs.writeFile(path.join(dir, 'renovation', 'AGENTS.md'), '1234');
  await fs.writeFile(path.join(dir, 'renovation', 'photos', 'a.jpg'), Buffer.alloc(10));
  await fs.symlink(path.join(dir, 'notes.md'), path.join(dir, 'renovation', 'link.md'));
  await fs.symlink(dir, path.join(dir, 'renovation', 'loop'));
});

after(() => fs.rm(dir, { recursive: true, force: true }));

describe('the totals of a directory tree', () => {
  test('count every regular file with its bytes, per top-level folder too; links and empty folders add nothing', async () => {
    const now = new Date('2026-10-11T12:00:00Z');
    const measured = await measureDirectory(dir, now);

    assert.deepEqual(measured, {
      measuredAt: now,
      files: 4,
      bytes: 3 + 6 + 4 + 10,
      folders: { renovation: { files: 2, bytes: 14 }, empty: { files: 0, bytes: 0 } },
      complete: true,
    });
  });

  test('a missing directory, or a file, is no measurement', async () => {
    assert.equal(await measureDirectory(path.join(dir, 'nowhere')), null);
    assert.equal(await measureDirectory(path.join(dir, 'notes.md')), null);
  });
});
