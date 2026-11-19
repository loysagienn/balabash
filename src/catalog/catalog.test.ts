// The build of the catalog: what it derives from the author's tree and which
// rules of the scheme stop it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { CatalogBuildError, accountConnectionOf, buildCatalog } from './catalog.ts';
import { capability, node, type RootDefinition, type Vertex } from './definition.ts';
import { testCatalog, testRoot } from './test-tree.ts';
import { FileRef, JsonObject, JsonValue, namedType } from './types.ts';

const leaf = (overrides: Partial<Parameters<typeof capability>[0]> = {}) =>
  capability({
    name: 'ping',
    summary: 'Answer at once',
    description: 'Answer at once.',
    input: z.strictObject({}),
    output: z.strictObject({ ok: z.boolean() }),
    run: () => ({ ok: true }),
    ...overrides,
  });

const root = (children: Vertex[], overrides: Partial<RootDefinition> = {}): RootDefinition => ({
  summary: 'The root.',
  children,
  ...overrides,
});

function problemsOf(definition: RootDefinition): string[] {
  try {
    buildCatalog(definition);
  } catch (error) {
    assert.ok(error instanceof CatalogBuildError);

    return error.problems;
  }

  return [];
}

function assertProblem(definition: RootDefinition, pattern: RegExp): void {
  const problems = problemsOf(definition);

  assert.ok(
    problems.some(text => pattern.test(text)),
    `expected a problem matching ${pattern}, got:\n${problems.join('\n') || '(none)'}`,
  );
}

describe('the build of the catalog', () => {
  const catalog = testCatalog();

  it('names every vertex by its path from the root, joined by underscores', () => {
    assert.deepEqual(
      [...catalog.vertices.keys()],
      [
        '',
        'get_note',
        'export_note',
        'notes',
        'notes_list',
        'notes_update',
        'notes_archive',
        'notes_archive_purge',
        'mail',
        'mail_send',
        'mail_labels',
        'mail_labels_list',
        'search',
        'search_query',
      ],
    );
  });

  it('adds the account field to every capability under an account connection, sub-nodes included', () => {
    for (const name of ['mail_send', 'mail_labels_list']) {
      const vertex = catalog.vertices.get(name);

      assert.ok(vertex?.kind === 'capability');
      assert.equal(accountConnectionOf(vertex)?.service, 'mail');
      assert.deepEqual((vertex.input.properties as Record<string, unknown>).account, {
        type: 'string',
        description: 'The account to act as.',
      });
      assert.ok((vertex.input.required as string[]).includes('account'));
    }

    const query = catalog.vertices.get('search_query');

    assert.ok(query?.kind === 'capability');
    assert.equal(accountConnectionOf(query), null);
    assert.equal(query.connectionNode?.fullName, 'search');
    assert.equal('account' in (query.input.properties as Record<string, unknown>), false);
  });

  it('collects the named types of a signature with the types those use', () => {
    const list = catalog.vertices.get('notes_list');

    assert.ok(list?.kind === 'capability');
    assert.deepEqual(list.types, ['TestNote', 'FileRef', 'FileId']);
    assert.deepEqual([...catalog.types.keys()].sort(), [
      'Account',
      'CapabilityError',
      'FileId',
      'FileRef',
      'JsonObject',
      'JsonValue',
      'TestNote',
      'WorkspacePath',
    ]);
  });

  it('keeps a named type a reference and a field comment beside it', () => {
    const exported = catalog.vertices.get('export_note');

    assert.ok(exported?.kind === 'capability');
    assert.deepEqual(exported.input.properties, {
      path: { description: 'Where the note lies.', $ref: '#/types/WorkspacePath' },
    });
    assert.deepEqual(exported.output, { $ref: '#/types/FileRef' });
    assert.deepEqual(catalog.types.get('WorkspacePath')?.schema, { type: 'string', maxLength: 300 });
  });

  it('keeps the form of the verbatim types: a JSON object is an object of JSON values', () => {
    const { catalog: built } = buildCatalog(
      root([
        leaf({
          input: z.strictObject({ options: JsonObject.describe('Form set by the agent.').optional() }),
          output: z.strictObject({ ok: z.boolean(), raw: JsonValue }),
        }),
      ]),
    );
    const ping = built.vertices.get('ping');

    assert.ok(ping?.kind === 'capability');
    assert.deepEqual(ping.input.properties, {
      options: { description: 'Form set by the agent.', $ref: '#/types/JsonObject' },
    });
    assert.deepEqual(ping.types, ['JsonObject', 'JsonValue']);
    assert.deepEqual(built.types.get('JsonObject')?.schema, {
      type: 'object',
      additionalProperties: { $ref: '#/types/JsonValue' },
    });
    assert.deepEqual(built.types.get('JsonValue')?.schema, {});
  });

  it('reports every broken rule at once', () => {
    const problems = problemsOf(root([leaf({ name: 'Ping' }), leaf({ name: 'pong', summary: 'Two. Sentences.' })]));

    assert.equal(problems.length, 3);
  });
});

describe('the rules of the scheme that stop the build', () => {
  it('names: a snake_case segment, unique full names, not the name of an action', () => {
    assertProblem(root([leaf({ name: 'getNote' })]), /getNote: name "getNote" is not a snake_case segment/);
    assertProblem(root([leaf({ name: 'call' })]), /call: the full name is taken by an action/);
    assertProblem(root([leaf({ name: 'read(' })]), /read\(: name "read\(" is not a snake_case segment/);
    assertProblem(
      root([
        leaf({ name: 'notes_list' }),
        node({ name: 'notes', summary: 'Notes.', children: [leaf({ name: 'list' })] }),
      ]),
      /notes_list: two vertices share this full name/,
    );
  });

  it('summaries: one sentence without a closing period', () => {
    assertProblem(root([leaf({ summary: 'Answer at once.' })]), /the summary ends with a period/);
    assertProblem(root([leaf({ summary: 'Answer. At once' })]), /the summary is more than one sentence/);
    assertProblem(root([leaf({ summary: '' })]), /no summary/);
    assertProblem(root([leaf({ description: '' })]), /no description/);
  });

  it('inputs: a strict object, no null, camelCase fields, no account field of its own', () => {
    assertProblem(root([leaf({ input: z.object({ id: z.string() }) })]), /ping: input must be a strict object/);
    assertProblem(
      root([leaf({ input: z.strictObject({ id: z.string().nullable() }) })]),
      /ping input\.id: null in an input type/,
    );
    assertProblem(
      root([leaf({ input: z.strictObject({ note_id: z.string() }) })]),
      /ping input\.note_id: field name is not camelCase/,
    );
    assertProblem(
      root([leaf({ input: z.strictObject({ file: FileRef }) })]),
      /ping input\.file: the output type FileRef stands in an input/,
    );
    assertProblem(
      root([
        node({
          name: 'mail',
          summary: 'Mail.',
          connection: { type: 'account', service: 'mail', summary: 'Mail.' },
          children: [leaf({ input: z.strictObject({ account: z.string() }) })],
        }),
      ]),
      /mail_ping input\.account: the account field is added by the platform/,
    );
  });

  it('outputs: every key always present, strict objects, the pair kind: "file" reserved', () => {
    assertProblem(
      root([leaf({ output: z.strictObject({ ok: z.boolean().optional() }) })]),
      /ping output\.ok: an output key that is not always present/,
    );
    assertProblem(
      root([leaf({ output: z.looseObject({ ok: z.boolean() }) })]),
      /ping output: an object with properties must set additionalProperties: false/,
    );
    assertProblem(
      root([leaf({ output: z.strictObject({ kind: z.literal('file'), id: z.string() }) })]),
      /ping output\.kind: the pair kind: "file" is reserved for FileRef/,
    );
  });

  it('a value of any form is carried only by the verbatim types, which take nothing but JSON', () => {
    assertProblem(root([leaf({ output: z.unknown() })]), /ping output: a value of any form/);
    assertProblem(
      root([leaf({ output: z.strictObject({ data: z.record(z.string(), z.any()) }) })]),
      /ping output\.data\{\}: a value of any form/,
    );
    assertProblem(
      root([leaf({ input: z.strictObject({ items: z.array(z.unknown()) }) })]),
      /ping input\.items\[\]: a value of any form/,
    );
    assertProblem(
      root([leaf({ output: z.strictObject({ count: z.bigint() }) })]),
      /ping output: the type does not convert/,
    );
    assert.equal(JsonValue.safeParse({ count: 5n }).success, false);
    assert.equal(JsonObject.safeParse({ at: new Date() }).success, false);
    assert.equal(JsonObject.safeParse('text').success, false);
  });

  it('an input carries only what its signature prints', () => {
    assertProblem(
      root([leaf({ input: z.strictObject({ email: z.email() }) })]),
      /ping input\.email: "format" in an input type, which the signature cannot print/,
    );
    assertProblem(
      root([leaf({ input: z.strictObject({ pair: z.tuple([z.string(), z.string()]) }) })]),
      /ping input\.pair: "prefixItems" in an input type/,
    );
    assertProblem(
      root([leaf({ input: z.strictObject({ id: z.union([z.string().max(5), z.boolean()]) }) })]),
      /ping input\.id<anyOf 0>: a limit inside a union \[≤5 chars\], which the signature does not print/,
    );
    assert.deepEqual(problemsOf(root([leaf({ output: z.strictObject({ email: z.email() }) })])), []);
  });

  it('an external node keeps the field names of its server in inputs only', () => {
    const ext = (overrides: Parameters<typeof leaf>[0]) =>
      root([node({ name: 'ext', summary: 'External.', external: true, children: [leaf(overrides)] })]);

    assert.deepEqual(problemsOf(ext({ input: z.strictObject({ page_id: z.string() }) })), []);
    assertProblem(
      ext({ output: z.strictObject({ page_id: z.string() }) }),
      /ext_ping output\.page_id: field name is not camelCase/,
    );
  });

  it('lists page one way: limit and cursor in, nextCursor out', () => {
    assertProblem(
      root([
        leaf({
          input: z.strictObject({ cursor: z.string().optional() }),
          output: z.strictObject({ items: z.array(z.string()) }),
        }),
      ]),
      /a paged list takes limit and cursor and returns nextCursor/,
    );

    const Page = namedType(
      'TestPage',
      { description: 'One page of a test list.' },
      z.strictObject({ items: z.array(z.string()), nextCursor: z.string().nullable() }),
    );

    assert.deepEqual(
      problemsOf(
        root([
          leaf({
            input: z.strictObject({ limit: z.int().min(1).max(50).default(10), cursor: z.string().optional() }),
            output: Page,
          }),
        ]),
      ),
      [],
    );
    assertProblem(root([leaf({ output: Page })]), /a paged list takes limit and cursor and returns nextCursor/);
  });

  it('input rules name optional fields of the input', () => {
    const input = z.strictObject({ id: z.string(), title: z.string().optional(), size: z.int().default(1) });

    assertProblem(
      root([leaf({ input, inputRules: [{ exactlyOne: ['title', 'body'] }] })]),
      /names "body", which is not an input field/,
    );
    assertProblem(
      root([leaf({ input, inputRules: [{ exactlyOne: ['title', 'id'] }] })]),
      /names "id", which is required/,
    );
    assertProblem(
      root([leaf({ input, inputRules: [{ atMostOne: ['title', 'size'] }] })]),
      /names "size", which has a default/,
    );
    assertProblem(
      root([leaf({ input, inputRules: [{ atMostOne: ['title'] }] })]),
      /an input rule that is not exactlyOne, atLeastOne or atMostOne over two or more fields/,
    );
  });

  it('texts: a named vertex exists and stands in backticks, examples are banned', () => {
    assertProblem(
      root([node({ name: 'notes', summary: 'Notes.', children: [leaf({ description: 'See `notes_get` first.' })] })]),
      /names `notes_get`, which is not in the catalog/,
    );
    assertProblem(
      root([leaf(), leaf({ name: 'pong_now', description: 'Answer after pong_now.' })]),
      /names pong_now without backticks/,
    );
    assertProblem(root([leaf({ description: 'Answer at once, e.g. now.' })]), /the text carries an example/);
    assertProblem(root([leaf()], { summary: 'The root with `ping`.' }), /a node summary names capabilities/);
  });

  it('recipes: what lies outside the node is listed in requires, what lies inside is implied', () => {
    const notes = (guide: NonNullable<RootDefinition['guide']>) =>
      root([leaf(), node({ name: 'notes', summary: 'Notes.', guide, children: [leaf({ name: 'list' })] })]);

    assert.deepEqual(problemsOf(notes([{ text: 'Use `notes_list`, then `ping`.', requires: ['ping'] }])), []);
    assertProblem(
      notes([{ text: 'Use `notes_list`, then `ping`.' }]),
      /names `ping` from outside the node without listing it in requires/,
    );
    assertProblem(
      notes([{ text: 'Use `notes_list`.', requires: ['notes_list'] }]),
      /requires "notes_list", which is a capability of this node and is implied/,
    );
    assertProblem(notes([{ text: 'Use it.', requires: ['pong'] }]), /requires "pong", which is not in the catalog/);
    assertProblem(root([leaf()], { guide: [{ text: 'Use `ping`.' }] }), /names `ping` from outside the node/);
  });

  it('types: a type of both sides obeys the rules of both', () => {
    const Shared = namedType(
      'TestSharedType',
      { description: 'A type that stands in inputs and in outputs.', use: 'any' },
      z.strictObject({ id: z.string().nullable(), note: z.string().optional(), file: FileRef }),
    );
    const problems = problemsOf(root([leaf({ input: z.strictObject({ shared: Shared }) })]));

    assert.deepEqual(
      problems.filter(text => text.startsWith('types.TestSharedType')),
      [
        'types.TestSharedType.id: null in an input type (an optional field is left out instead)',
        'types.TestSharedType.note: an output key that is not always present (an optional field in an output)',
        'types.TestSharedType.file: the output type FileRef stands in an input',
      ],
    );
  });

  it('types: an output type is strict too', () => {
    const Loose = namedType(
      'TestLooseType',
      { description: 'A type with a key that may be absent.' },
      z.strictObject({ id: z.string().optional() }),
    );

    assertProblem(
      root([leaf({ output: Loose })]),
      /types\.TestLooseType\.id: an output key that is not always present/,
    );
  });
});

describe('warnings of the build', () => {
  it('a text over its length guide is a warning, not a problem', () => {
    const { warnings } = buildCatalog(root([leaf({ summary: 'A'.repeat(91) })]));

    assert.deepEqual(warnings, ['ping: the summary is 91 characters (budget 90)']);
    assert.deepEqual(buildCatalog(testRoot()).warnings, []);
  });
});
