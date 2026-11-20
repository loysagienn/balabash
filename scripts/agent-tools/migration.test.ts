import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import pg from 'pg';
import { createTestDatabase } from '../../src/test-support/pg.ts';

test('offline move rolls back on collision, preserves mixed history and runs once', async t => {
  const db = await createTestDatabase();
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  t.after(async () => {
    await client.end();
    await db.drop();
  });
  const migrate = async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['scripts/migrate-agent-tools.ts', '--database', db.name],
      { env: { ...process.env, DATABASE_URL: db.url } },
    );
    return JSON.parse(stdout);
  };
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

  await assert.rejects(migrate());
  const kind = async () => (await client.query('SELECT kind FROM scheduled_tasks')).rows[0].kind;
  assert.equal(await kind(), 'command');
  await client.query('DELETE FROM schedule_runs');
  assert.deepEqual(await migrate(), { tasks: 1, seeds: 0, jobs: 1, renamed: 10, completed: 5, failures: 0 });
  const { rows } = await client.query('SELECT id,type,payload FROM events');
  const payload = (id: string) => rows.find(row => row.id === id)!.payload;
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
