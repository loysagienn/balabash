import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { loadTaskBody } from './catalog.ts';

describe('loadTaskBody', () => {
  const roots: string[] = [];

  after(async () => {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  });

  // A workspace area under a "type": "commonjs" package.json (an npm init
  // for shared packages): the tasks/ directory still loads as ESM.
  async function area(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'balabash-tasks-'));

    roots.push(root);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'workspace', type: 'commonjs' }));
    await mkdir(path.join(root, 'u1', 'tasks'), { recursive: true });

    return path.join(root, 'u1', 'tasks');
  }

  it('loads an ESM body below a commonjs package.json, keeping the scope file in tasks/', async () => {
    const tasks = await area();
    const file = path.join(tasks, 'probe.ts');

    await writeFile(file, 'export async function run(ctx: { workspaceId: string }): Promise<void> {\n  void ctx;\n}\n');

    const run = await loadTaskBody(file);

    assert.equal(typeof run, 'function');
    assert.deepEqual(JSON.parse(await readFile(path.join(tasks, 'package.json'), 'utf8')), { type: 'module' });
  });

  it('corrects a tasks/package.json of another type, keeping its other fields', async () => {
    const tasks = await area();
    const file = path.join(tasks, 'probe.ts');

    await writeFile(path.join(tasks, 'package.json'), JSON.stringify({ name: 'tasks', type: 'commonjs' }));
    await writeFile(file, 'export async function run(): Promise<void> {}\n');

    await loadTaskBody(file);

    assert.deepEqual(JSON.parse(await readFile(path.join(tasks, 'package.json'), 'utf8')), { name: 'tasks', type: 'module' });
  });

  it('rejects a module with exports beside run', async () => {
    const tasks = await area();
    const file = path.join(tasks, 'extra.ts');

    await writeFile(file, 'export async function run(): Promise<void> {}\nexport const other = 1;\n');

    await assert.rejects(loadTaskBody(file), /must export only "run"/);
  });
});
