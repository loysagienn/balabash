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
      [' plain/notes.md', /write it as "plain\/notes\.md"/],
      ['plain\\notes.md', /write it as "plain\/notes\.md"/],
      ['plain/', /empty segments/],
    ] as const) {
      await refuses(invoke('workspace_files_stat', { path: given }), 'invalid_input', message);
    }

    assert.equal((await invoke('workspace_files_stat', { path: 'plain/notes.md' })).path, 'plain/notes.md');
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

  test("SQL that SQLite rejects, that holds nothing, or that would run in part is the caller's to change", async () => {
    await refuses(invoke('workspace_query', { sql: 'SELEKT 1' }), 'invalid_input', /syntax error/);
    await refuses(invoke('workspace_query', { sql: 'SELECT * FROM no_such_table' }), 'invalid_input', /no such table/);
    await refuses(invoke('workspace_query', { sql: '  ' }), 'invalid_input', /holds no statement/);
    await refuses(invoke('workspace_query', { sql: '-- only a comment' }), 'invalid_input', /holds no statement/);
    await refuses(
      invoke('workspace_query', { sql: "SELECT 1; INSERT INTO items (name) VALUES ('lost')" }),
      'invalid_input',
      /first statement returns rows and another statement follows/,
    );
    // The statement after the rows did not run; a trailing comment is not a statement.
    assert.deepEqual((await invoke('workspace_query', { sql: "SELECT count(*) AS n FROM items WHERE name = 'lost'; -- done" })).rows, [{ n: 0 }]);
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
