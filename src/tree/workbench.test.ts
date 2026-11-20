// The file capabilities of the root and the node `workspace`, called the way
// every caller reaches them: through a grant and the one path of a call
// (src/catalog), over the stand's database, file storage and file area.
// What the texts and the signatures say is checked against the design
// catalog outside the repository; here is what the actions do: the forms of
// the values, what lands on disk and in storage, the border of the
// workspace and the refusals.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CapabilityError, computeGrant, invokeCapability } from '../catalog/index.ts';
import type { ConnectionsPort, ErrorKind, Grant } from '../catalog/index.ts';
import type { JsonObject } from '../core/contract.ts';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';

const NO_CONNECTIONS: ConnectionsPort = {
  accounts: async () => [],
  secretsReady: async () => false,
  accountAuthority: async () => {
    throw new Error('no account is connected');
  },
  secretAuthority: async () => {
    throw new Error('no secret is entered');
  },
};

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let files: typeof import('../files/index.ts');
let tree: typeof import('./index.ts');
let grant: Grant;
// The file area of the stand's workspace.
let area: string;
// A second workspace: what the caller must not reach.
let foreign: { workspaceId: string; grant: Grant };

type Value = Record<string, any>;

async function grantOf(workspaceId: string, threadId: string): Promise<Grant> {
  return computeGrant(
    tree.catalog(),
    { allows: () => true, actions: ['describe', 'call'] },
    { caller: { workspaceId, threadId, agentName: 'tester' }, connections: NO_CONNECTIONS },
  );
}

function invoke(name: string, input: JsonObject, as: Grant = grant, signal?: AbortSignal): Promise<Value> {
  return invokeCapability(as, name, input, { connections: NO_CONNECTIONS, signal }) as Promise<Value>;
}

async function refuses(call: Promise<unknown>, kind: ErrorKind, message: RegExp): Promise<CapabilityError> {
  let refusal: CapabilityError | null = null;

  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof CapabilityError, `a CapabilityError, got ${String(error)}`);
    assert.equal(error.kind, kind, error.message);
    assert.match(error.message, message);
    refusal = error;

    return true;
  });

  return refusal!;
}

// A file of the stand's file area, written past the capabilities: the way a
// shell or a script leaves it.
async function put(relPath: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(path.join(area, relPath)), { recursive: true });
  await fs.writeFile(path.join(area, relPath), content);
}

function onDisk(relPath: string): Promise<string> {
  return fs.readFile(path.join(area, relPath), 'utf8');
}

async function store(content: string | Buffer, name: string | null, contentType: string | null, workspaceId = stand.workspaceId): Promise<string> {
  const file = await files.ingestFile({ body: content, workspaceId, originalFilename: name, contentType });

  return file.id;
}

async function storedText(fileId: string): Promise<string> {
  return new Response(await files.openFileContent(fileId)).text();
}

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  files = await import('../files/index.ts');
  tree = await import('./index.ts');
  grant = await grantOf(stand.workspaceId, stand.mainThreadId);
  area = path.join(stand.dir, 'data', 'workspace', stand.workspaceId, 'files');

  const { ensureMainThread } = await import('../core/threads.ts');
  const { id: workspaceId } = await prisma.workspace.create({ data: {} });
  const main = await ensureMainThread(workspaceId);

  foreign = { workspaceId, grant: await grantOf(workspaceId, main.id) };
});

after(() => stand.stop());

describe('a path of the workspace file area', () => {
  test('is relative, inside the area and in its one plain form', async () => {
    await put('plain/notes.md', 'here');

    for (const [given, message] of [
      ['../outside.md', /must not contain ".."/],
      ['/etc/passwd', /not absolute/],
      ['plain//notes.md', /empty segments/],
      ['./plain/notes.md', /write it as "plain\/notes\.md"/],
      [' plain/notes.md', /begins or ends with white space.*not addressed here/],
      ['plain\\notes.md', /holds a backslash.*not addressed here/],
      ['plain/', /empty segments/],
      ['plain/no\0tes.md', /NUL character/],
      ['a'.repeat(301), /<=300 characters/],
    ] as const) {
      await refuses(invoke('workspace_files_stat', { path: given }), 'invalid_input', message);
    }

    assert.equal((await invoke('workspace_files_stat', { path: 'plain/notes.md' })).path, 'plain/notes.md');
  });

  test('a path of a listing names the file it stands for, and a refusal never points at a neighbour', async () => {
    // Names a shell leaves: a space inside the path is part of a name the
    // area addresses; white space at the edge of the whole path and a
    // backslash are not, and the refusal does not offer the file beside.
    await put('odd/ draft.txt', 'inner space');
    await put('odd/draft.txt', 'the neighbour');
    await put(' edge.txt', 'edge space');
    await put('edge.txt', 'the neighbour');
    await put('odd/back\\slash.txt', 'backslash');

    const listing = await invoke('workspace_files_list', { path: 'odd' });

    assert.deepEqual(listing.files.map((file: Value) => file.path), ['odd/ draft.txt', 'odd/back\\slash.txt', 'odd/draft.txt']);
    assert.deepEqual(
      [(await invoke('workspace_files_stat', { path: 'odd/ draft.txt' })).sizeBytes, (await invoke('workspace_files_read', { path: 'odd/ draft.txt' })).content],
      [11, 'inner space'],
    );

    const edge = await refuses(invoke('workspace_files_delete', { path: ' edge.txt' }), 'invalid_input', /not addressed here/);

    assert.doesNotMatch(edge.message, /write it as/);
    await refuses(invoke('workspace_files_delete', { path: 'odd/back\\slash.txt' }), 'invalid_input', /not addressed here/);
    assert.deepEqual([await onDisk(' edge.txt'), await onDisk('edge.txt'), await onDisk('odd/draft.txt')], ['edge space', 'the neighbour', 'the neighbour']);
  });

  test('a path longer than a path can be is not passed for a defect, nor left out in silence', async () => {
    const deep = `long/${'d'.repeat(200)}`;

    await put(`${deep}/${'f'.repeat(120)}.txt`, 'far');
    await put(`${deep}/near.txt`, 'near');

    const refusal = await refuses(invoke('workspace_files_list', { path: deep }), 'conflict', /longer than 300 characters/);

    assert.match(refusal.message, /reached from a shell/);
    assert.equal((await invoke('workspace_files_read', { path: `${deep}/near.txt` })).content, 'near');
    // A name longer than a name of the file system can be: nothing is there, and nothing can be put there.
    await refuses(invoke('workspace_files_stat', { path: `long/${'n'.repeat(290)}` }), 'not_found', /no file/);
    await refuses(invoke('workspace_files_write', { path: `long/${'n'.repeat(290)}`, content: 'x' }), 'invalid_input', /longer than the file system takes/);
  });
});

describe('export_file', () => {
  test('stores the file and gives its reference; the reference fixes the content as of the call', async () => {
    await put('reports/summary.md', '# Summary\n');

    const ref = await invoke('export_file', { path: 'reports/summary.md' });

    assert.deepEqual(ref, {
      kind: 'file',
      id: ref.id,
      name: 'summary.md',
      contentType: 'text/markdown',
      sizeBytes: 10,
      width: null,
      height: null,
    });

    await put('reports/summary.md', 'rewritten after the export');

    assert.equal(await storedText(ref.id), '# Summary\n');
    assert.equal((await files.getWorkspaceFile(stand.workspaceId, ref.id)).id, ref.id);
  });

  test('carries the name and the type the call gives; the type follows the name', async () => {
    await put('reports/data.bin', 'a;b\n1;2\n');

    const named = await invoke('export_file', { path: 'reports/data.bin', name: 'table.csv' });
    const typed = await invoke('export_file', { path: 'reports/data.bin', name: 'table.csv', contentType: 'text/plain' });

    assert.deepEqual([named.name, named.contentType], ['table.csv', 'text/csv']);
    assert.deepEqual([typed.name, typed.contentType], ['table.csv', 'text/plain']);

    await refuses(invoke('export_file', { path: 'reports/data.bin', name: '  ' }), 'invalid_input', /name is blank/);
  });

  test('a file larger than storage takes is refused before anything is stored', async () => {
    const handle = await fs.open(path.join(area, 'reports/sparse.bin'), 'w');

    // A sparse file: the size without the bytes.
    await handle.truncate(2 ** 31);
    await handle.close();

    await refuses(invoke('export_file', { path: 'reports/sparse.bin' }), 'invalid_input', /larger than a stored file can be/);
    await fs.rm(path.join(area, 'reports/sparse.bin'));
  });

  test('a missing path and a directory are not a file', async () => {
    await refuses(invoke('export_file', { path: 'reports/absent.md' }), 'not_found', /no file at "reports\/absent\.md"/);
    await refuses(invoke('export_file', { path: 'reports' }), 'not_found', /no file at "reports"/);
  });
});

describe('import_file', () => {
  test('with a path the file is written exactly there, folders created, and replaces what was there', async () => {
    const first = await store('first version', 'draft.txt', 'text/plain');
    const second = await store('second version', 'draft.txt', 'text/plain');

    assert.deepEqual(await invoke('import_file', { file: first, path: 'inbox/deep/draft.txt' }), { path: 'inbox/deep/draft.txt' });
    assert.equal(await onDisk('inbox/deep/draft.txt'), 'first version');

    assert.deepEqual(await invoke('import_file', { file: second, path: 'inbox/deep/draft.txt' }), { path: 'inbox/deep/draft.txt' });
    assert.equal(await onDisk('inbox/deep/draft.txt'), 'second version');
    // Nothing of the transfer is left beside the file.
    assert.deepEqual(await fs.readdir(path.join(area, 'inbox/deep')), ['draft.txt']);
  });

  test('without a path the file lands under imports/ by its stored name and nothing is overwritten', async () => {
    const one = await store('one', 'photo.png', 'image/png');
    const other = await store('another picture', 'photo.png', 'image/png');

    assert.deepEqual(await invoke('import_file', { file: one }), { path: 'imports/photo.png' });
    // The same bytes imported again are the same file.
    assert.deepEqual(await invoke('import_file', { file: one }), { path: 'imports/photo.png' });
    // Other bytes under the same name land beside it.
    assert.deepEqual(await invoke('import_file', { file: other }), { path: 'imports/photo (2).png' });
    assert.equal(await onDisk('imports/photo.png'), 'one');
    assert.equal(await onDisk('imports/photo (2).png'), 'another picture');
  });

  test('a file stored without a name lands by its id', async () => {
    const nameless = await store('bytes', null, null);

    assert.deepEqual(await invoke('import_file', { file: nameless }), { path: `imports/${nameless}` });
  });

  test('a path taken by a directory, or lying under a file, is the state of the area', async () => {
    const file = await store('content', 'a.txt', 'text/plain');

    await put('taken/inside.txt', 'x');

    await refuses(invoke('import_file', { file, path: 'taken' }), 'conflict', /"taken" is taken by something that is not a file/);
    await refuses(invoke('import_file', { file, path: 'taken/inside.txt/below.txt' }), 'conflict', /taken by a file/);
    assert.equal(await onDisk('taken/inside.txt'), 'x');
  });

  test('an unknown file and a file of another workspace are not found alike', async () => {
    const theirs = await store('theirs', 'secret.txt', 'text/plain', foreign.workspaceId);

    await refuses(invoke('import_file', { file: 'no-such-file' }), 'not_found', /no stored file "no-such-file"/);
    await refuses(invoke('import_file', { file: theirs }), 'not_found', /no stored file/);
    await refuses(invoke('get_file_url', { file: theirs }), 'not_found', /no stored file/);
    await refuses(invoke('view_file', { file: theirs }), 'not_found', /no stored file/);
  });
});

describe('get_file_url', () => {
  test('gives an address that serves the bytes without authorization until it expires', async () => {
    const file = await store('downloadable', 'file.txt', 'text/plain');
    const before = Date.now();
    const value = await invoke('get_file_url', { file });

    assert.deepEqual(Object.keys(value), ['url', 'expiresAt']);
    assert.equal(new Date(value.expiresAt).toISOString(), value.expiresAt);
    assert.ok(new Date(value.expiresAt).getTime() > before, 'expires in the future');

    const url = new URL(value.url);
    const reply = await stand.request('GET', url.pathname + url.search, { cookie: null });

    assert.equal(reply.status, 200);
    assert.equal(reply.text, 'downloadable');
  });
});

describe('view_file', () => {
  test('the value is the reference of an image, a PDF or a text file', async () => {
    const image = await store(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'shot.png', 'image/png');
    const pdf = await store('%PDF-1.7', 'paper.pdf', 'application/pdf');
    const text = await store('{"a":1}', 'data.json', 'application/json; charset=utf-8');
    // Stored without a telling type: the name decides.
    const byName = await store('# Notes', 'notes.md', 'application/octet-stream');

    assert.deepEqual(await invoke('view_file', { file: image }), {
      kind: 'file',
      id: image,
      name: 'shot.png',
      contentType: 'image/png',
      sizeBytes: 4,
      width: null,
      height: null,
    });

    for (const file of [pdf, text, byName]) {
      assert.equal((await invoke('view_file', { file })).id, file);
    }
  });

  test('a file that is neither is refused', async () => {
    const archive = await store('PK', 'bundle.zip', 'application/zip');
    const tiff = await store('II*', 'scan.tiff', 'image/tiff');
    const unknown = await store('?', null, null);

    for (const file of [archive, tiff, unknown]) {
      await refuses(invoke('view_file', { file }), 'invalid_input', /neither an image .* a PDF nor text/);
    }
  });

  test('how a file is shown is decided by its type in one place', async () => {
    const { viewKind } = await import('./files.ts');
    const kind = (contentType: string | null, originalFilename: string | null = null) => viewKind({ contentType, originalFilename });

    assert.equal(kind('IMAGE/JPEG'), 'image');
    assert.equal(kind('image/webp'), 'image');
    assert.equal(kind('image/svg+xml'), 'text');
    assert.equal(kind('application/pdf'), 'pdf');
    assert.equal(kind('text/csv; charset=utf-8'), 'text');
    assert.equal(kind('application/ld+json'), 'text');
    assert.equal(kind(null, 'script.py'), 'text');
    assert.equal(kind(null, 'scan.PDF'), 'pdf');
    assert.equal(kind('application/octet-stream', 'archive.tar'), null);
    assert.equal(kind('video/mp4'), null);
  });
});

describe('workspace_query', () => {
  test('a statement that returns no rows gives changes; several of them go in one call', async () => {
    const created = await invoke('workspace_query', {
      sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, weight REAL, body BLOB); INSERT INTO items (name, weight, body) VALUES ('a', 1.5, x'00010203'), ('b', NULL, NULL);",
    });

    assert.deepEqual(created, { rows: null, truncated: false, changes: 2 });
    assert.deepEqual(await invoke('workspace_query', { sql: "UPDATE items SET name = 'c' WHERE id = 99" }), { rows: null, truncated: false, changes: 0 });
  });

  test('a row-returning statement gives rows: text, numbers, null, and a blob as its size', async () => {
    assert.deepEqual(await invoke('workspace_query', { sql: 'SELECT id, name, weight, body FROM items ORDER BY id' }), {
      rows: [
        { id: 1, name: 'a', weight: 1.5, body: { blobSizeBytes: 4 } },
        { id: 2, name: 'b', weight: null, body: null },
      ],
      truncated: false,
      changes: null,
    });
    assert.deepEqual(await invoke('workspace_query', { sql: 'SELECT id FROM items WHERE id > 100' }), { rows: [], truncated: false, changes: null });
    // RETURNING makes a write row-returning.
    assert.deepEqual(await invoke('workspace_query', { sql: "INSERT INTO items (name) VALUES ('d') RETURNING id" }), {
      rows: [{ id: 3 }],
      truncated: false,
      changes: null,
    });
  });

  test('the rows are cut at 200 and at about 50 KB, and the value says so', async () => {
    const series = 'WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < 300)';
    const byRows = await invoke('workspace_query', { sql: `${series} SELECT n FROM series` });

    assert.equal(byRows.rows.length, 200);
    assert.equal(byRows.truncated, true);

    const byBytes = await invoke('workspace_query', { sql: `${series} SELECT n, printf('%.*c', 1000, 'x') AS filler FROM series` });

    assert.ok(byBytes.rows.length < 60 && byBytes.rows.length > 30, `${byBytes.rows.length} rows of a kilobyte each`);
    assert.equal(byBytes.truncated, true);

    await refuses(
      invoke('workspace_query', { sql: "SELECT printf('%.*c', 60000, 'x') AS huge" }),
      'invalid_input',
      /first row alone is larger than the cap/,
    );
  });

  test('the cap is counted in bytes: text of two-byte characters takes half the rows', async () => {
    const series = 'WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < 150)';
    const { rows, truncated } = await invoke('workspace_query', { sql: `${series} SELECT printf('%.*c', 500, 'я') AS filler FROM series` });

    assert.equal(truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(rows)) <= 50_000, `${Buffer.byteLength(JSON.stringify(rows))} bytes`);
    assert.ok(rows.length > 40 && rows.length < 50, `${rows.length} rows of a kilobyte each`);
    // A first row that fills the cap by its bytes, not by its characters.
    await refuses(invoke('workspace_query', { sql: "SELECT printf('%.*c', 30000, 'я') AS huge" }), 'invalid_input', /first row alone is larger than the cap/);
  });

  test('a write that returns rows has written, whatever the caps leave of its rows', async () => {
    const count = async (where: string) => (await invoke('workspace_query', { sql: `SELECT count(*) AS n FROM returned WHERE ${where}` })).rows[0].n;

    await invoke('workspace_query', { sql: 'CREATE TABLE returned (id INTEGER PRIMARY KEY, body TEXT)' });

    // A first row over the cap: the refusal of a read would say "nothing
    // happened", and the row is in the table — the answer is a success
    // that shows its rows were cut.
    assert.deepEqual(await invoke('workspace_query', { sql: "INSERT INTO returned (body) VALUES (printf('%.*c', 60000, 'x')) RETURNING body" }), {
      rows: [],
      truncated: true,
      changes: null,
    });
    assert.equal(await count('length(body) = 60000'), 1);

    // More rows than the cap: every row is written, 200 come back.
    const many = await invoke('workspace_query', {
      sql: "WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < 300) INSERT INTO returned (body) SELECT 'row ' || n FROM series RETURNING id",
    });

    assert.deepEqual([many.rows.length, many.truncated, many.changes], [200, true, null]);
    assert.equal(await count("body LIKE 'row %'"), 300);
  });

  test('several statements run one after another, each cut where SQLite ends it', async () => {
    // A statement stands on the one before it; a semicolon in a string, in a
    // comment and in the body of a trigger ends nothing.
    const script = `
      CREATE TABLE script_log (note TEXT); -- a comment; with a semicolon
      CREATE TABLE script_items (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TRIGGER script_items_log AFTER INSERT ON script_items BEGIN
        INSERT INTO script_log (note) VALUES ('added; ' || new.name);
        UPDATE script_log SET note = note || ';' WHERE note = '';
      END;
      /* a block; comment */
      INSERT INTO script_items (name) VALUES ('one; two'), ('three');;
      UPDATE script_items SET name = upper(name) WHERE id = 2;
    `;

    assert.deepEqual(await invoke('workspace_query', { sql: script }), { rows: null, truncated: false, changes: 5 });
    assert.deepEqual((await invoke('workspace_query', { sql: 'SELECT name FROM script_items ORDER BY id' })).rows, [{ name: 'one; two' }, { name: 'THREE' }]);
    assert.deepEqual((await invoke('workspace_query', { sql: 'SELECT note FROM script_log ORDER BY rowid' })).rows, [{ note: 'added; one; two' }, { note: 'added; three' }]);
  });

  test('a script longer than the window its statements are cut by runs whole', async () => {
    // 6 000 statements, about 400 KB: statements cross every edge of a window.
    const inserts = Array.from({ length: 6_000 }, (_, index) => `INSERT INTO bulk (n, note) VALUES (${index}, '${'я'.repeat(index % 40)}; ${index}');`);
    const value = await invoke('workspace_query', { sql: `CREATE TABLE bulk (n INTEGER, note TEXT);\n${inserts.join('\n')}` });

    assert.deepEqual(value, { rows: null, truncated: false, changes: 6_000 });
    assert.deepEqual((await invoke('workspace_query', { sql: 'SELECT count(*) AS n, sum(n) AS total, max(length(note)) AS longest FROM bulk' })).rows, [
      { n: 6_000, total: (5_999 * 6_000) / 2, longest: 45 },
    ]);

    // One statement larger than the window.
    const wide = await invoke('workspace_query', { sql: `INSERT INTO bulk (n, note) VALUES (-1, '${'w'.repeat(200_000)}'); DELETE FROM bulk WHERE n = 0` });

    assert.deepEqual(wide, { rows: null, truncated: false, changes: 2 });
  });

  test("SQL that SQLite rejects, that holds nothing, or that would lose its rows is the caller's to change", async () => {
    await refuses(invoke('workspace_query', { sql: 'SELEKT 1' }), 'invalid_input', /syntax error/);
    await refuses(invoke('workspace_query', { sql: 'SELECT * FROM no_such_table' }), 'invalid_input', /no such table/);
    await refuses(invoke('workspace_query', { sql: '  ' }), 'invalid_input', /holds no statement/);
    await refuses(invoke('workspace_query', { sql: '-- only a comment' }), 'invalid_input', /holds no statement/);
    await refuses(invoke('workspace_query', { sql: 'SELECT 1 \0 FROM items' }), 'invalid_input', /NUL character/);
    await refuses(
      invoke('workspace_query', { sql: "SELECT 1; INSERT INTO items (name) VALUES ('lost')" }),
      'invalid_input',
      /Statement 1 returns rows.*Nothing has run/,
    );
    // The statement after the rows did not run; a trailing comment is not a statement.
    assert.deepEqual((await invoke('workspace_query', { sql: "SELECT count(*) AS n FROM items WHERE name = 'lost'; -- done" })).rows, [{ n: 0 }]);
  });

  test('a script that stops half-way says what has run, and the database agrees', async () => {
    const names = async () => (await invoke('workspace_query', { sql: "SELECT name FROM halfway ORDER BY name" })).rows.map((row: Value) => row.name);

    // Rows in a statement that is not the first: seen only once the ones
    // before it have run.
    const late = await refuses(
      invoke('workspace_query', { sql: "CREATE TABLE halfway (name TEXT UNIQUE); INSERT INTO halfway VALUES ('kept'); SELECT * FROM halfway; INSERT INTO halfway VALUES ('never')" }),
      'invalid_input',
      /Statement 3 returns rows/,
    );

    assert.match(late.message, /Statements 1–2 have run and what they changed is kept: do not run them again\. Run the row-returning statement in a call of its own/);
    assert.deepEqual(await names(), ['kept']);

    // A failure of SQLite in a later statement.
    const failed = await refuses(
      invoke('workspace_query', { sql: "INSERT INTO halfway VALUES ('second'); INSERT INTO halfway VALUES ('kept'); INSERT INTO halfway VALUES ('never')" }),
      'invalid_input',
      /Statement 2: UNIQUE constraint failed/,
    );

    assert.match(failed.message, /Statement 1 has run and what it changed is kept: do not run it again/);
    assert.deepEqual(await names(), ['kept', 'second']);

    // The script's own transaction: a failure inside it rolls it back.
    const rolledBack = await refuses(
      invoke('workspace_query', { sql: "INSERT INTO halfway VALUES ('before'); BEGIN; INSERT INTO halfway VALUES ('inside'); INSERT INTO halfway VALUES ('kept'); COMMIT" }),
      'invalid_input',
      /Statement 4: UNIQUE constraint failed/,
    );

    assert.match(rolledBack.message, /the transaction the script opened is rolled back, what ran before it is kept/);
    assert.deepEqual(await names(), ['before', 'kept', 'second']);

    // A transaction left open would be lost at the end of the call: said, not passed for a success.
    await refuses(invoke('workspace_query', { sql: "BEGIN; INSERT INTO halfway VALUES ('unfinished')" }), 'invalid_input', /leaves a transaction open.*rolled back/);
    assert.deepEqual(await names(), ['before', 'kept', 'second']);
    assert.deepEqual(await invoke('workspace_query', { sql: "BEGIN; INSERT INTO halfway VALUES ('committed'); COMMIT" }), { rows: null, truncated: false, changes: 1 });
  });

  test("the database is the workspace's own", async () => {
    await refuses(invoke('workspace_query', { sql: 'SELECT * FROM items' }, foreign.grant), 'invalid_input', /no such table/);
  });
});

describe('workspace_run_command', () => {
  test('exit code 0 gives the output; the command runs in the file area and reaches the database', async () => {
    await put('scripts/hello.sh', 'echo "hello from $(basename "$PWD")"\n');

    const value = await invoke('workspace_run_command', { command: 'bash scripts/hello.sh; echo warn >&2' });

    assert.deepEqual(Object.keys(value), ['stdout', 'stdoutTruncated', 'stderr', 'stderrTruncated', 'durationMs']);
    assert.deepEqual([value.stdout, value.stdoutTruncated, value.stderr, value.stderrTruncated], ['hello from files\n', false, 'warn\n', false]);
    assert.ok(Number.isInteger(value.durationMs));

    const inFolder = await invoke('workspace_run_command', { command: 'pwd; test -f "$WORKSPACE_DB" && echo database', cwd: 'scripts' });

    assert.match(inFolder.stdout, /\/files\/scripts\ndatabase\n$/);
  });

  test("the environment is the short list, not the app's", async () => {
    process.env.BALABASH_TEST_SECRET = 'must not leak';

    try {
      const { stdout } = await invoke('workspace_run_command', { command: 'env' });

      assert.doesNotMatch(stdout, /BALABASH_TEST_SECRET|DATABASE_URL|SESSION_PEPPER/);
      assert.match(stdout, /^WORKSPACE_DB=.*workspace\.sqlite$/m);
    } finally {
      delete process.env.BALABASH_TEST_SECRET;
    }
  });

  test('any other exit code is an error that carries the code and the output', async () => {
    const refusal = await refuses(
      invoke('workspace_run_command', { command: 'echo partial; echo broke >&2; exit 3' }),
      'external_error',
      /exited with code 3/,
    );

    assert.deepEqual(refusal.details, {
      exitCode: 3,
      timedOut: false,
      stdout: 'partial\n',
      stdoutTruncated: false,
      stderr: 'broke\n',
      stderrTruncated: false,
    });
  });

  test('a command out of time is killed with everything it started', async () => {
    const startedAt = Date.now();
    const refusal = await refuses(
      invoke('workspace_run_command', { command: 'echo started; (sleep 2; echo late > survived.txt) & wait', timeoutSeconds: 1 }),
      'external_error',
      /ran longer than 1 seconds and was killed/,
    );

    assert.ok(Date.now() - startedAt < 10_000, 'the call does not wait for the command');
    assert.deepEqual(refusal.details, { exitCode: null, timedOut: true, stdout: 'started\n', stdoutTruncated: false, stderr: '', stderrTruncated: false });

    // What the command left in the background went with it.
    await new Promise(resolve => setTimeout(resolve, 1_800));
    await assert.rejects(fs.stat(path.join(area, 'survived.txt')), /ENOENT/);
  });

  test('a cancelled call kills its command; the shutdown of the app kills them all', async () => {
    const { countRunningCommands, killRunningCommands } = await import('./workspace.ts');
    const cancel = new AbortController();
    const cancelled = invoke('workspace_run_command', { command: 'sleep 30' }, grant, cancel.signal);
    const swept = invoke('workspace_run_command', { command: 'sleep 30' });

    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(countRunningCommands(), 2);

    cancel.abort();

    const refusal = await refuses(cancelled, 'external_error', /the call was cancelled/);

    assert.deepEqual([(refusal.details as JsonObject).exitCode, (refusal.details as JsonObject).timedOut], [null, false]);
    assert.equal(countRunningCommands(), 1);

    killRunningCommands();
    await refuses(swept, 'external_error', /was killed/);
    assert.equal(countRunningCommands(), 0);
  });

  // Whether a process is still there: a killed one is gone, or waits as a
  // zombie for the init of the host to collect it.
  async function gone(pid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = await fs.readFile(`/proc/${pid}/stat`, 'utf8').then(
        stat => stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3),
        () => null,
      );

      if (state === null || state === 'Z') {
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, 50));
    }

    return false;
  }

  test('what a command leaves in the background ends with the command', async () => {
    // The shell exits at once and its output is closed: the job in the
    // background holds nothing of the call, and still belongs to it.
    const value = await invoke('workspace_run_command', { command: 'sleep 30 > /dev/null 2>&1 & echo $!' });
    const pid = Number(value.stdout.trim());

    assert.ok(Number.isInteger(pid) && pid > 0, value.stdout);
    assert.ok(await gone(pid), 'the background job was killed when the command ended');
  });

  test('a command killed after its shell had exited did not succeed', async () => {
    // The shell exits with 0 at once; the job it started holds the output,
    // so the command is not over — and is then cancelled, or runs out of time.
    const cancel = new AbortController();
    const cancelled = invoke('workspace_run_command', { command: 'echo begun; sleep 30 &' }, grant, cancel.signal);

    await new Promise(resolve => setTimeout(resolve, 400));
    cancel.abort();

    const refusal = await refuses(cancelled, 'external_error', /the call was cancelled/);

    assert.deepEqual(refusal.details, { exitCode: null, timedOut: false, stdout: 'begun\n', stdoutTruncated: false, stderr: '', stderrTruncated: false });

    const late = await refuses(invoke('workspace_run_command', { command: 'sleep 30 &', timeoutSeconds: 1 }), 'external_error', /ran longer than 1 seconds/);

    assert.deepEqual([(late.details as JsonObject).exitCode, (late.details as JsonObject).timedOut], [null, true]);
  });

  test('a call cancelled before its command exists starts nothing, and is counted from the moment it is taken', async () => {
    const { countRunningCommands, killRunningCommands } = await import('./workspace.ts');
    const cancel = new AbortController();

    cancel.abort();

    const refusal = await refuses(
      invoke('workspace_run_command', { command: 'echo ran > never-started.txt' }, grant, cancel.signal),
      'external_error',
      /was not started: the call was cancelled/,
    );

    assert.deepEqual(refusal.details, { exitCode: null, timedOut: false, stdout: '', stdoutTruncated: false, stderr: '', stderrTruncated: false });

    // The shutdown reaches a call that is still on its way to a process.
    const taken = invoke('workspace_run_command', { command: 'echo ran > never-started.txt' });

    assert.equal(countRunningCommands(), 1);
    killRunningCommands();
    await refuses(taken, 'external_error', /was not started/);
    assert.equal(countRunningCommands(), 0);
    await assert.rejects(fs.stat(path.join(area, 'never-started.txt')), /ENOENT/);
  });

  test('a character is never broken, neither between two chunks of the output nor by the cap', async () => {
    // Bytes of one character written apart: two chunks of the stream.
    const split = await invoke('workspace_run_command', { command: "printf '\\321'; sleep 0.3; printf '\\217\\n'" });

    assert.equal(split.stdout, 'я\n');

    // 15 000 characters of two units each: the cap of 20 000 falls on a whole character.
    const capped = await invoke('workspace_run_command', { command: "printf 'a'; for i in $(seq 1 15000); do printf '😀'; done" });

    assert.equal(capped.stdoutTruncated, true);
    assert.equal(capped.stdout, '😀'.repeat(10_000));
  });

  test('the output is capped per stream with the end kept', async () => {
    const value = await invoke('workspace_run_command', { command: 'head -c 30000 /dev/zero | tr "\\0" a; echo; echo the-end' });

    assert.equal(value.stdout.length, 20_000);
    assert.equal(value.stdoutTruncated, true);
    assert.ok(value.stdout.endsWith('\nthe-end\n'));
    assert.equal(value.stderrTruncated, false);
  });

  test('a limit out of range is refused by the type, a missing folder is not found', async () => {
    await refuses(invoke('workspace_run_command', { command: 'true', timeoutSeconds: 0 }), 'invalid_input', /timeoutSeconds/);
    await refuses(invoke('workspace_run_command', { command: 'true', timeoutSeconds: 18_001 }), 'invalid_input', /timeoutSeconds/);
    await refuses(invoke('workspace_run_command', { command: 'true', timeoutSeconds: 1.5 }), 'invalid_input', /timeoutSeconds/);
    await refuses(invoke('workspace_run_command', { command: 'true', cwd: 'no/such/folder' }), 'not_found', /no directory at "no\/such\/folder"/);
    await refuses(invoke('workspace_run_command', { command: 'true', cwd: 'scripts/hello.sh' }), 'not_found', /no directory/);
  });
});

describe('workspace_files', () => {
  test('write creates a file with its folders and its annotation; read gives it back', async () => {
    const written = await invoke('workspace_files_write', {
      path: 'notes/2026/plan.md',
      content: '# Plan\n',
      title: 'Plan',
      description: 'What comes next.',
    });

    assert.deepEqual(written, {
      path: 'notes/2026/plan.md',
      sizeBytes: 7,
      modifiedAt: written.modifiedAt,
      title: 'Plan',
      description: 'What comes next.',
    });
    assert.equal(new Date(written.modifiedAt).toISOString(), written.modifiedAt);
    assert.deepEqual(await invoke('workspace_files_read', { path: 'notes/2026/plan.md' }), { content: '# Plan\n', truncated: false, sizeBytes: 7 });
    assert.deepEqual(await invoke('workspace_files_stat', { path: 'notes/2026/plan.md' }), written);
  });

  test('an omitted title or description keeps its value, with content and without', async () => {
    const retitled = await invoke('workspace_files_write', { path: 'notes/2026/plan.md', title: 'The plan' });

    assert.deepEqual([retitled.title, retitled.description, retitled.sizeBytes], ['The plan', 'What comes next.', 7]);
    assert.equal(await onDisk('notes/2026/plan.md'), '# Plan\n');

    const rewritten = await invoke('workspace_files_write', { path: 'notes/2026/plan.md', content: '' });

    assert.deepEqual([rewritten.title, rewritten.description, rewritten.sizeBytes], ['The plan', 'What comes next.', 0]);
    assert.equal(await onDisk('notes/2026/plan.md'), '');
  });

  test('the annotation of a rewritten file is stamped, a file never annotated is left to the annotator', async () => {
    await invoke('workspace_files_write', { path: 'notes/bare.txt', content: 'no annotation' });

    const { rows } = await invoke('workspace_query', { sql: "SELECT path, updated_at >= datetime('now', '-1 minute') AS fresh FROM _files ORDER BY path" });

    assert.deepEqual(rows, [{ path: 'notes/2026/plan.md', fresh: 1 }]);
  });

  test('an annotation written by hand is never older than its file, by the comparison the annotator makes', async () => {
    const { readAnnotationTimes } = await import('../workspace/files.ts');
    // What the indexer asks of every file: is it newer than its annotation?
    const wouldBeAnnotatedOver = async (relPath: string) => {
      const annotatedAt = (await readAnnotationTimes(stand.workspaceId)).get(relPath);
      const { mtime } = await fs.stat(path.join(area, relPath));

      return !annotatedAt || mtime > annotatedAt;
    };

    // Several writes, so that some land late in their second.
    for (let round = 0; round < 6; round += 1) {
      await invoke('workspace_files_write', { path: 'stamped/titled.md', content: `round ${round}`, title: 'By hand' });
      assert.equal(await wouldBeAnnotatedOver('stamped/titled.md'), false, 'written with its title');

      // New content under the title it had.
      await invoke('workspace_files_write', { path: 'stamped/titled.md', content: `round ${round}, again` });
      assert.equal(await wouldBeAnnotatedOver('stamped/titled.md'), false, 'rewritten under its title');
      await new Promise(resolve => setTimeout(resolve, 170));
    }

    // A file dated ahead of the clock keeps its annotation too.
    const ahead = new Date(Date.now() + 3_600_000);

    await fs.utimes(path.join(area, 'stamped/titled.md'), ahead, ahead);
    await invoke('workspace_files_write', { path: 'stamped/titled.md', description: 'Dated ahead.' });
    assert.equal(await wouldBeAnnotatedOver('stamped/titled.md'), false, 'dated ahead of the clock');
    assert.equal((await invoke('workspace_files_stat', { path: 'stamped/titled.md' })).title, 'By hand');
  });

  test('writes and a delete of one path run one at a time, the content with its annotation', async () => {
    // Twenty writes at once: the file ends as one of them, whole — the
    // content and the title of the same call.
    const writes = Array.from({ length: 20 }, (_, index) =>
      invoke('workspace_files_write', { path: 'raced/file.md', content: `content ${index}`, title: `title ${index}` }),
    );

    await Promise.all(writes);

    const [content, { title }] = [await onDisk('raced/file.md'), await invoke('workspace_files_stat', { path: 'raced/file.md' })];

    assert.equal(title, content.replace('content', 'title'));

    // A write and a delete at once: the file with its annotation, or neither.
    for (let round = 0; round < 5; round += 1) {
      await Promise.allSettled([
        invoke('workspace_files_write', { path: 'raced/gone.md', content: 'x', title: 'Kept or gone' }),
        invoke('workspace_files_delete', { path: 'raced/gone.md' }),
      ]);

      const exists = await fs.stat(path.join(area, 'raced/gone.md')).then(() => true, () => false);
      const annotated = (await invoke('workspace_query', { sql: "SELECT count(*) AS n FROM _files WHERE path = 'raced/gone.md'" })).rows[0].n;

      assert.equal(annotated, exists ? 1 : 0, `round ${round}`);
    }
  });

  test('write refuses what it cannot mean', async () => {
    await refuses(invoke('workspace_files_write', { path: 'notes/absent.md', title: 'Nothing there' }), 'not_found', /pass content to create it/);
    await refuses(invoke('workspace_files_write', { path: 'notes/2026/plan.md' }), 'invalid_input', /at least one of/i);
    await refuses(invoke('workspace_files_write', { path: 'notes/2026/plan.md', title: ' ' }), 'invalid_input', /title is blank/);
    await refuses(invoke('workspace_files_write', { path: 'notes/2026', content: 'x' }), 'conflict', /taken by a directory/);
    await refuses(invoke('workspace_files_write', { path: 'notes/bare.txt/below.md', content: 'x' }), 'conflict', /taken by a file/);
    assert.deepEqual((await fs.readdir(path.join(area, 'notes'))).sort(), ['2026', 'bare.txt']);
  });

  test('read gives up to 50 000 characters and never half a character', async () => {
    await put('big/ascii.txt', 'a'.repeat(50_000));
    await put('big/longer.txt', 'a'.repeat(50_001));
    // Two bytes per character: the byte limit of the read falls inside the text.
    await put('big/cyrillic.txt', 'я'.repeat(120_000));
    // The 50 000th unit is the first half of a pair.
    await put('big/pair.txt', `${'a'.repeat(49_999)}😀tail`);

    assert.deepEqual(await invoke('workspace_files_read', { path: 'big/ascii.txt' }), { content: 'a'.repeat(50_000), truncated: false, sizeBytes: 50_000 });

    const longer = await invoke('workspace_files_read', { path: 'big/longer.txt' });

    assert.deepEqual([longer.content.length, longer.truncated, longer.sizeBytes], [50_000, true, 50_001]);

    const cyrillic = await invoke('workspace_files_read', { path: 'big/cyrillic.txt' });

    assert.deepEqual([cyrillic.content, cyrillic.truncated, cyrillic.sizeBytes], ['я'.repeat(50_000), true, 240_000]);

    const pair = await invoke('workspace_files_read', { path: 'big/pair.txt' });

    assert.deepEqual([pair.content, pair.truncated], ['a'.repeat(49_999), true]);
  });

  test('list gives one directory: folders as paths and files with what describes them, by name', async () => {
    await put('listing/b.txt', 'bb');
    await put('listing/a.txt', 'a');
    await put('listing/sub/inner.txt', 'deep');
    await invoke('workspace_files_write', { path: 'listing/a.txt', title: 'First' });

    const listing = await invoke('workspace_files_list', { path: 'listing' });

    assert.deepEqual(listing.directories, ['listing/sub']);
    assert.deepEqual(
      listing.files.map((file: Value) => [file.path, file.sizeBytes, file.title, file.description]),
      [
        ['listing/a.txt', 1, 'First', null],
        ['listing/b.txt', 2, null, null],
      ],
    );
    assert.deepEqual(Object.keys(listing.files[0]), ['path', 'sizeBytes', 'modifiedAt', 'title', 'description']);

    const root = await invoke('workspace_files_list', {});

    assert.ok(root.directories.includes('listing') && root.directories.includes('notes'));
    await refuses(invoke('workspace_files_list', { path: 'listing/absent' }), 'not_found', /no directory at "listing\/absent"/);
    await refuses(invoke('workspace_files_list', { path: 'listing/a.txt' }), 'not_found', /no directory/);
  });

  test('a workspace that never wrote anything reads as an empty area, and reading provides nothing', async () => {
    const { ensureMainThread } = await import('../core/threads.ts');
    const { id: workspaceId } = await prisma.workspace.create({ data: {} });
    const untouched = await grantOf(workspaceId, (await ensureMainThread(workspaceId)).id);

    assert.deepEqual(await invoke('workspace_files_list', {}, untouched), { directories: [], files: [] });
    await refuses(invoke('workspace_files_read', { path: 'a.txt' }, untouched), 'not_found', /no file/);
    await refuses(invoke('workspace_files_stat', { path: 'a.txt' }, untouched), 'not_found', /no file/);
    await refuses(invoke('workspace_files_delete', { path: 'a.txt' }, untouched), 'not_found', /no file/);
    await refuses(invoke('export_file', { path: 'a.txt' }, untouched), 'not_found', /no file/);
    assert.deepEqual(await invoke('workspace_apps_list', {}, untouched), { apps: [] });
    await assert.rejects(fs.stat(path.join(stand.dir, 'data', 'workspace', workspaceId)), /ENOENT/);
  });

  test('stat and read take a file, not a directory', async () => {
    await refuses(invoke('workspace_files_stat', { path: 'listing' }), 'not_found', /no file at "listing"/);
    await refuses(invoke('workspace_files_read', { path: 'listing' }), 'not_found', /no file at "listing"/);
    await refuses(invoke('workspace_files_stat', { path: 'listing/absent.txt' }), 'not_found', /no file/);
  });

  test('delete removes one file together with its annotation', async () => {
    assert.equal(await invoke('workspace_files_delete', { path: 'listing/a.txt' }), null);
    await assert.rejects(fs.stat(path.join(area, 'listing/a.txt')), /ENOENT/);
    assert.deepEqual((await invoke('workspace_query', { sql: "SELECT count(*) AS n FROM _files WHERE path = 'listing/a.txt'" })).rows, [{ n: 0 }]);

    await refuses(invoke('workspace_files_delete', { path: 'listing/a.txt' }), 'not_found', /no file/);
    await refuses(invoke('workspace_files_delete', { path: 'listing/sub' }), 'invalid_input', /is a directory/);
    assert.equal(await onDisk('listing/sub/inner.txt'), 'deep');
  });
});

describe('workspace_apps', () => {
  const manifest = (name: string) => JSON.stringify({ name, description: `${name} app`, entry: 'main.tsx' });

  before(async () => {
    await put('apps-area/tracker/balabash-app.json', manifest('Tracker'));
    await put('apps-area/tracker/main.tsx', 'export default () => null;');
    await put('apps-area/broken/balabash-app.json', '{ "name": 42 }');
    await put('apps-area/second/balabash-app.json', manifest('Second'));
    await put('apps-area/plain/readme.md', 'not an app');
  });

  test('list gives every app folder with its manifest and publication state', async () => {
    const { apps } = await invoke('workspace_apps_list', {});

    assert.deepEqual(apps[1], {
      path: 'apps-area/second',
      name: 'Second',
      description: 'Second app',
      manifestError: null,
      slug: null,
      ownerUrl: 'https://console.test/apps/apps-area/second',
      publicUrl: null,
    });
    assert.deepEqual(apps.map((app: Value) => app.path), ['apps-area/broken', 'apps-area/second', 'apps-area/tracker']);
    assert.deepEqual([apps[0].name, apps[0].description], [null, null]);
    assert.match(apps[0].manifestError, /failed validation/);
  });

  test('publish opens the app under the slug, in the name of the calling thread', async () => {
    assert.deepEqual(await invoke('workspace_apps_publish', { path: 'apps-area/tracker', slug: 'my-tracker' }), {
      publicUrl: 'https://console.test/a/my-tracker',
    });

    const event = await prisma.event.findFirstOrThrow({ where: { type: 'app.published' }, orderBy: { seq: 'desc' } });

    assert.deepEqual([event.actor, event.threadId, event.workspaceId], ['agent', stand.mainThreadId, stand.workspaceId]);
    assert.deepEqual(event.payload, { path: 'apps-area/tracker', slug: 'my-tracker', name: 'Tracker', description: 'Tracker app' });

    const { apps } = await invoke('workspace_apps_list', {});
    const tracker = apps.find((app: Value) => app.path === 'apps-area/tracker');

    assert.deepEqual([tracker.slug, tracker.publicUrl], ['my-tracker', 'https://console.test/a/my-tracker']);
  });

  test('publish refuses a reserved or malformed slug, a folder that is not an app, and what the state does not allow', async () => {
    await refuses(invoke('workspace_apps_publish', { path: 'apps-area/second', slug: 'apps' }), 'invalid_input', /reserved/);
    await refuses(invoke('workspace_apps_publish', { path: 'apps-area/second', slug: 'Not_A_Slug' }), 'invalid_input', /slug/);
    await refuses(invoke('workspace_apps_publish', { path: 'apps-area/plain', slug: 'plain' }), 'not_found', /not an app/);
    await refuses(invoke('workspace_apps_publish', { path: 'apps-area/absent', slug: 'absent' }), 'not_found', /not an app/);
    await refuses(invoke('workspace_apps_publish', { path: 'apps-area/broken', slug: 'broken' }), 'conflict', /manifest is broken/);
    await refuses(invoke('workspace_apps_publish', { path: 'apps-area/tracker', slug: 'again' }), 'conflict', /Already published as "my-tracker"/);
    await refuses(invoke('workspace_apps_publish', { path: 'apps-area/second', slug: 'my-tracker' }), 'conflict', /slug "my-tracker" is taken/);
  });

  test('unpublish takes the slug or the folder; the slug decides when both are given', async () => {
    await invoke('workspace_apps_publish', { path: 'apps-area/second', slug: 'second' });

    // Another workspace publishes nothing under this slug.
    await refuses(invoke('workspace_apps_unpublish', { slug: 'my-tracker' }, foreign.grant), 'not_found', /Nothing is published as "my-tracker"/);

    assert.deepEqual(await invoke('workspace_apps_unpublish', { path: 'apps-area/second', slug: 'my-tracker' }), {
      path: 'apps-area/tracker',
      slug: 'my-tracker',
    });

    const event = await prisma.event.findFirstOrThrow({ where: { type: 'app.unpublished' }, orderBy: { seq: 'desc' } });

    assert.deepEqual([event.actor, event.threadId, event.payload], ['agent', stand.mainThreadId, { path: 'apps-area/tracker', slug: 'my-tracker' }]);

    assert.deepEqual(await invoke('workspace_apps_unpublish', { path: 'apps-area/second' }), { path: 'apps-area/second', slug: 'second' });
    await refuses(invoke('workspace_apps_unpublish', { path: 'apps-area/second' }), 'not_found', /is not published/);
    await refuses(invoke('workspace_apps_unpublish', { slug: 'my-tracker' }), 'not_found', /Nothing is published/);
    await refuses(invoke('workspace_apps_unpublish', {}), 'invalid_input', /at least one of/i);
    await refuses(invoke('workspace_apps_unpublish', { slug: ' ' }), 'invalid_input', /slug is blank/);
  });
});
