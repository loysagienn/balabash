import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import pg from 'pg';
import { gmailNewMail } from './gmail-new-mail.ts';
import { createTestDatabase } from '../../src/test-support/pg.ts';

async function fixture(t: TestContext) {
  const db = await createTestDatabase();
  // Release each inspection connection before the offline command starts.
  const client = new pg.Pool({ connectionString: db.url, maxUses: 1 });
  t.after(async () => {
    await client.end();
    await db.drop();
  });
  const migrate = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['scripts/migrate-agent-tools.ts', '--database', db.name, ...args],
      { env: { ...process.env, DATABASE_URL: db.url } },
    );
    return JSON.parse(stdout);
  };
  return { client, migrate, url: db.url };
}

test('offline move rolls back on collision, preserves mixed history and runs once', async t => {
  const { client, migrate, url } = await fixture(t);
  const ref = {
    kind: 'file',
    id: 'f',
    name: 'a.png',
    contentType: 'image/png',
    sizeBytes: 4,
    width: null,
    height: null,
  };
  const foreign = { kind: 'file', data: 123 };
  await client.query(`
    INSERT INTO files (id,bucket,object_key,workspace_id,original_filename,content_type,size_bytes,updated_at)
      VALUES ('f','local','f','w','a.png','image/png',4,now());
    INSERT INTO scheduled_tasks (id,slug,workspace_id,name,kind,command,cwd,report_on_success)
      VALUES ('t','daily','w','Daily','command','pwd','tools',true);
    INSERT INTO job_runs (id,workspace_id,slug,command,trigger,status)
      VALUES ('j','w','daily','pwd','manual','spawn_error');
    INSERT INTO schedule_runs (id,workspace_id,slug,code,trigger,status,started_at)
      VALUES ('j','w','other','return null;','manual','ok',now());`);
  const pair = async (id: string, end: object) => {
    for (const [type, payload] of [
      ['started', { input: {} }],
      ['completed', end],
    ] as const) {
      await client.query(
        `INSERT INTO events (id,type,actor,agent_name,thread_id,workspace_id,payload)
        VALUES ($1,$2,'agent','coordinator','thread','w',$3)`,
        [id + type, 'tool.call.' + type, { callId: id, functionName: 'storage_get_file', ...payload }],
      );
    }
  };
  await pair('linked', { result: { content: [{ type: 'image', fileId: 'f' }] } });
  await pair('blocks', {
    result: {
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', data: 'BASE64' },
      ],
    },
  });
  await pair('scalar', { result: { content: [], structuredContent: false } });
  await pair('foreign', { result: { content: [], structuredContent: foreign } });
  await pair('refusal', {
    result: {
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
      isError: true,
    },
  });
  await pair('modern', { value: 'unchanged' });

  await client.query(`
    INSERT INTO events (id,type,actor,agent_name,thread_id,workspace_id,payload)
    VALUES ('failed','tool.call.failed','agent','coordinator','thread','w',
            '{"callId":"failed","functionName":"storage_get_file","error":"provider offline"}')`);
  const peer = new pg.Client({ connectionString: url, application_name: 'idle-scheduler' });
  await peer.connect();
  try {
    await assert.rejects(migrate(), /Close other database connections.*idle-scheduler/);
  } finally {
    await peer.end();
  }
  await assert.rejects(migrate(), /Unique constraint|duplicate key/i);
  const kind = async () => (await client.query('SELECT kind FROM scheduled_tasks')).rows[0].kind;
  assert.equal(await kind(), 'command');
  await client.query('DELETE FROM schedule_runs');
  const counts = { tasks: 1, seeds: 0, jobs: 1, renamed: 11, completed: 5, failures: 1 };
  assert.deepEqual(await migrate('--dry-run'), counts);
  assert.equal(await kind(), 'command');
  assert.deepEqual(await migrate(), counts);
  const { rows } = await client.query('SELECT id,type,payload FROM events');
  const payload = (id: string) => rows.find(row => row.id === id)!.payload;
  assert.deepEqual(payload('failed').error, { kind: 'external_error', message: 'provider offline' });
  assert.deepEqual(payload('linkedcompleted').value, ref);
  assert.equal(payload('blockscompleted').value, 'before\n[image omitted]');
  assert.equal(payload('scalarcompleted').value, false);
  assert.deepEqual(payload('foreigncompleted').value, foreign);
  assert.equal(payload('refusalcompleted').error.message, 'first\nsecond');
  assert.equal(rows.find(row => row.id === 'refusalcompleted')!.type, 'tool.call.failed');
  for (const row of rows)
    assert.equal(row.payload.functionName, row.id.startsWith('modern') ? 'storage_get_file' : 'view_file');
  assert.equal(await kind(), 'program');
  const task = (await client.query('SELECT code,timeout_ms FROM scheduled_tasks')).rows[0];
  assert.equal(task.timeout_ms, 600000);
  const run = new Function('call', 'console', 'return (async () => {' + task.code + '})()');
  assert.deepEqual(
    await run(
      async (name: string, input: object) => {
        assert.equal(name, 'workspace_run_command');
        assert.deepEqual(input, { command: 'pwd', cwd: 'tools', timeoutSeconds: 600 });
        return { stdout: 'out', stderr: '' };
      },
      { log() {} },
    ),
    { output: 'out' },
  );
  assert.deepEqual(await migrate(), { tasks: 0, seeds: 0, jobs: 0, renamed: 0, completed: 0, failures: 0 });
});

test('code task replacements and the last five Gmail deliveries belong to their workspace', async t => {
  const { client, migrate } = await fixture(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-programs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const args = ['--workspaces', dir, '--programs', dir];
  await client.query(`
    INSERT INTO scheduled_tasks (id,slug,workspace_id,name,kind)
    VALUES ('t','gmail-new-mail','w','Mail','code');
    INSERT INTO events (id,type,actor,thread_id,workspace_id,payload)
    SELECT 'mail-' || n,'schedule.fired','system','thread',CASE WHEN n = 7 THEN 'other' ELSE 'w' END,
           jsonb_build_object('slug','gmail-new-mail','name','Mail','count',n)
    FROM generate_series(1,7) n ORDER BY n`);
  await assert.rejects(migrate(...args), /Supply the translated program with --programs DIR: w\/gmail-new-mail.js/);
  await fs.mkdir(path.join(dir, 'w', 'tasks'), { recursive: true });
  await fs.writeFile(path.join(dir, 'w', 'tasks', 'gmail-new-mail.ts'), '// installation-specific task');
  await assert.rejects(migrate(...args), /Supply the translated program/);
  const file = path.join(dir, 'w', 'gmail-new-mail.js');
  await fs.writeFile(file, 'return 123;');
  assert.equal((await migrate(...args, '--dry-run')).seeds, 0);
  await fs.writeFile(file, gmailNewMail);
  assert.deepEqual(await migrate(...args), { tasks: 1, seeds: 5, jobs: 0, renamed: 0, completed: 0, failures: 0 });
  assert.equal((await client.query('SELECT code FROM scheduled_tasks')).rows[0].code, gmailNewMail);
  const seeds = await client.query(`
    SELECT r.id, r.value, r.has_value, r.started_at = e.created_at AND r.finished_at = e.created_at AS same_time
    FROM schedule_runs r JOIN events e ON e.id = r.id ORDER BY e.seq`);
  assert.deepEqual(seeds.rows, [2, 3, 4, 5, 6].map(n => ({
    id: 'mail-' + n, value: { count: n }, has_value: true, same_time: true,
  })));
});
