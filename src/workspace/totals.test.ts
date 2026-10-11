// The totals of a file area (src/workspace/totals.ts): every regular file
// counted with its bytes, per top-level folder too; a hidden file counts,
// a symbolic link does not — not at the root, not one a folder or a file
// became after its listing; a missing directory is no measurement; what
// the walk cannot read makes the measurement a lower bound, never a
// precise zero.
//
// Run: npm test

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { measureDirectory } from './totals.ts';

let dir: string;
let outside: string;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'balabash-totals-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'balabash-totals-outside-'));
  await fs.mkdir(path.join(dir, 'renovation', 'photos'), { recursive: true });
  await fs.mkdir(path.join(dir, 'empty'));
  await fs.writeFile(path.join(dir, 'notes.md'), 'abc');
  await fs.writeFile(path.join(dir, '.hidden'), 'hidden');
  await fs.writeFile(path.join(dir, 'renovation', 'AGENTS.md'), '1234');
  await fs.writeFile(path.join(dir, 'renovation', 'photos', 'a.jpg'), Buffer.alloc(10));
  await fs.symlink(path.join(dir, 'notes.md'), path.join(dir, 'renovation', 'link.md'));
  await fs.symlink(dir, path.join(dir, 'renovation', 'loop'));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'thirteen byte');
  await fs.symlink(dir, path.join(outside, 'area-link'));
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

const NOW = new Date('2026-10-11T12:00:00Z');

// The listing of one folder, with a swap on disk right after it — the
// walk reads the node again before descending or counting, so the swap is
// what a replacement between the listing and the read looks like.
async function withSwapAfterListing(folder: string, swap: () => Promise<void>, measure: () => Promise<unknown>): Promise<void> {
  const original = fs.readdir;
  let swapped = false;

  mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
    const names = await (original as (...a: Parameters<typeof fs.readdir>) => ReturnType<typeof fs.readdir>)(...args);

    if (!swapped && args[0] === folder) {
      swapped = true;
      await swap();
    }

    return names;
  });

  try {
    await measure();
  } finally {
    mock.restoreAll();
  }
}

describe('the totals of a directory tree', () => {
  test('count every regular file with its bytes, per top-level folder too; links and empty folders add nothing', async () => {
    const measured = await measureDirectory(dir, NOW);

    assert.deepEqual(measured, {
      measuredAt: NOW,
      files: 4,
      bytes: 3 + 6 + 4 + 10,
      folders: { renovation: { files: 2, bytes: 14 }, empty: { files: 0, bytes: 0 } },
      complete: true,
      unreadable: 0,
    });
  });

  test('a missing directory, a file, or a link to a directory is no measurement', async () => {
    assert.equal(await measureDirectory(path.join(dir, 'nowhere')), null);
    assert.equal(await measureDirectory(path.join(dir, 'notes.md')), null);
    assert.equal(await measureDirectory(path.join(outside, 'area-link')), null);
  });

  test('a folder replaced by a link after its listing is not descended into', async () => {
    const area = await fs.mkdtemp(path.join(os.tmpdir(), 'balabash-totals-swap-'));

    try {
      await fs.mkdir(path.join(area, 'child'));
      await fs.writeFile(path.join(area, 'child', 'own.txt'), 'own');

      await withSwapAfterListing(
        area,
        async () => {
          await fs.rm(path.join(area, 'child'), { recursive: true });
          await fs.symlink(outside, path.join(area, 'child'));
        },
        async () => {
          const measured = await measureDirectory(area, NOW);

          assert.deepEqual(measured, { measuredAt: NOW, files: 0, bytes: 0, folders: { child: { files: 0, bytes: 0 } }, complete: true, unreadable: 0 });
        },
      );
    } finally {
      await fs.rm(area, { recursive: true, force: true });
    }
  });

  test('a file replaced by a link after its listing is not counted', async () => {
    const area = await fs.mkdtemp(path.join(os.tmpdir(), 'balabash-totals-swap-'));

    try {
      await fs.writeFile(path.join(area, 'own.txt'), 'own');
      await fs.writeFile(path.join(area, 'kept.txt'), 'kept!');

      await withSwapAfterListing(
        area,
        async () => {
          await fs.rm(path.join(area, 'own.txt'));
          await fs.symlink(path.join(outside, 'secret.txt'), path.join(area, 'own.txt'));
        },
        async () => {
          const measured = await measureDirectory(area, NOW);

          assert.deepEqual(measured, { measuredAt: NOW, files: 1, bytes: 5, folders: {}, complete: true, unreadable: 0 });
        },
      );
    } finally {
      await fs.rm(area, { recursive: true, force: true });
    }
  });

  test('a folder that refuses its listing makes the measurement a lower bound, not a precise zero; one that vanished is just gone', async () => {
    const area = await fs.mkdtemp(path.join(os.tmpdir(), 'balabash-totals-refuse-'));

    try {
      await fs.mkdir(path.join(area, 'secret'));
      await fs.writeFile(path.join(area, 'secret', 'hidden.txt'), 'hidden');
      await fs.mkdir(path.join(area, 'open'));
      await fs.writeFile(path.join(area, 'open', 'seen.txt'), 'seen');

      const original = fs.readdir;

      mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
        if (args[0] === path.join(area, 'secret')) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }

        if (args[0] === path.join(area, 'open')) {
          await fs.rm(path.join(area, 'open'), { recursive: true });
        }

        return (original as (...a: Parameters<typeof fs.readdir>) => ReturnType<typeof fs.readdir>)(...args);
      });

      try {
        const measured = await measureDirectory(area, NOW);

        assert.deepEqual(measured, { measuredAt: NOW, files: 0, bytes: 0, folders: { secret: { files: 0, bytes: 0 }, open: { files: 0, bytes: 0 } }, complete: false, unreadable: 1 });
      } finally {
        mock.restoreAll();
      }
    } finally {
      await fs.rm(area, { recursive: true, force: true });
    }
  });

  test('a file that refuses its stat is unreadable; a folder named like a property of Object is a folder', async () => {
    const area = await fs.mkdtemp(path.join(os.tmpdir(), 'balabash-totals-proto-'));

    try {
      await fs.mkdir(path.join(area, '__proto__'));
      await fs.writeFile(path.join(area, '__proto__', 'a.txt'), 'ab');
      await fs.writeFile(path.join(area, 'locked.txt'), 'locked');

      const original = fs.lstat;

      mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
        if (args[0] === path.join(area, 'locked.txt')) {
          throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        }

        return (original as (...a: Parameters<typeof fs.lstat>) => ReturnType<typeof fs.lstat>)(...args);
      });

      try {
        const measured = await measureDirectory(area, NOW);

        assert.ok(measured);
        assert.deepEqual({ files: measured.files, bytes: measured.bytes, complete: measured.complete, unreadable: measured.unreadable }, { files: 1, bytes: 2, complete: false, unreadable: 1 });
        assert.ok(Object.hasOwn(measured.folders, '__proto__'));
        assert.deepEqual(measured.folders['__proto__'], { files: 1, bytes: 2 });
        assert.equal(JSON.stringify(measured.folders), '{"__proto__":{"files":1,"bytes":2}}');
      } finally {
        mock.restoreAll();
      }
    } finally {
      await fs.rm(area, { recursive: true, force: true });
    }
  });
});
