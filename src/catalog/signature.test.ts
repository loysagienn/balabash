// The printer of signatures: the texts of the actions and of the platform's
// types are the ones the design catalog shows (agent-tools-catalog-view.md),
// reached here from the zod definitions.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { capabilitySignature } from './describe.ts';
import { declarationText, typeDefinitionText } from './signature.ts';
import { testCatalog } from './test-tree.ts';

const catalog = testCatalog();

function action(name: 'describe' | 'call' | 'run_program'): string {
  const found = catalog.actions.get(name);

  assert.ok(found);

  return declarationText(found);
}

function type(name: string): string {
  const found = catalog.types.get(name);

  assert.ok(found, `type ${name} is in the catalog`);

  return typeDefinitionText(found);
}

function signature(name: string): string {
  const vertex = catalog.vertices.get(name);

  assert.ok(vertex?.kind === 'capability');

  return capabilitySignature(vertex);
}

describe('the signature printer', () => {
  it('prints describe: a union of two strict objects, named types by name', () => {
    assert.equal(
      action('describe'),
      [
        '/**',
        ' * Describe a vertex of the catalog. A node gives its guide and one line per child; a capability gives its',
        ' * full description and signature. Omit `name` for the root.',
        ' */',
        'describe(input: {',
        '  name?: string;  // Full name of a node or a capability.',
        '}): {',
        '  kind: "node";',
        '  name: string;  // Full name; empty for the root.',
        '  summary: string;',
        '  guide: string[];  // The recipes of the node that you can follow.',
        "  accounts: Account[];  // Accounts of the node's connection; empty when it needs none.",
        '  children: Array<{',
        '    kind: "node" | "capability";',
        '    name: string;  // Full name.',
        '    summary: string;',
        '  }>;',
        '} | {',
        '  kind: "capability";',
        '  name: string;  // Full name.',
        '  description: string;',
        '  signature: string;  // Input and output types in TypeScript notation.',
        '  types: string[];  // Definitions of the named types the signature uses.',
        "  accounts: Account[];  // Accounts of the node's connection; empty when it needs none.",
        '}',
      ].join('\n'),
    );
  });

  it('prints call and run_program: verbatim types, an integer range with a default', () => {
    assert.equal(
      action('call'),
      [
        '/**',
        ' * Call a capability by its full name. The input and the returned value follow the signature `describe` shows.',
        ' */',
        'call(input: {',
        '  name: string;  // Full name of the capability.',
        "  input?: JsonObject;  // Form set by the capability's signature.",
        '}): JsonValue',
      ].join('\n'),
    );

    assert.equal(
      action('run_program').split('\n').slice(-4).join('\n'),
      [
        'run_program(input: {',
        '  code: string;',
        '  timeoutSeconds?: number;  // [integer, 1..600, default 120]',
        '}): JsonValue',
      ].join('\n'),
    );
  });

  it('prints the types of the platform', () => {
    assert.equal(
      type('FileId'),
      '/** Id of a file in Balabash storage: the form a file takes in an input. */\ntype FileId = string;',
    );

    assert.equal(
      type('FileRef'),
      [
        '/** Reference to a file in Balabash storage: the form a file takes in an output. Identity and metadata, never content. */',
        'type FileRef = {',
        '  kind: "file";  // Marks a file inside any value.',
        '  id: FileId;',
        '  name: string | null;',
        '  contentType: string | null;  // MIME type.',
        '  sizeBytes: number | null;',
        '  width: number | null;  // Pixels; images only.',
        '  height: number | null;  // Pixels; images only.',
        '};',
      ].join('\n'),
    );

    assert.equal(
      type('JsonObject'),
      "/** A JSON object carried verbatim in another system's format; the field that uses it names what sets its form. */\ntype JsonObject = { [key: string]: JsonValue };",
    );

    assert.equal(
      type('JsonValue'),
      '/** Any JSON value carried verbatim; the field that uses it names what sets its form. */\ntype JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };',
    );

    assert.equal(
      type('CapabilityError'),
      [
        '/** What a failed call gives instead of a value. */',
        'type CapabilityError = {',
        '  kind: "invalid_input" | "unknown_capability" | "not_found" | "conflict" | "auth_required" | "external_error" | "unavailable" | "internal";  // Tells who can fix it.',
        '  message: string;  // What went wrong and what to change.',
        '  details?: JsonValue;  // Specifics of this error.',
        '};',
      ].join('\n'),
    );

    assert.equal(
      type('WorkspacePath'),
      '/** Path relative to the root of the workspace file area: no leading "/", no "." or ".." segments. */\ntype WorkspacePath = string;  // [≤300 chars]',
    );

    assert.equal(
      type('Account'),
      [
        '/** One account of a service connected, or being connected, in this workspace. */',
        'type Account = {',
        '  account: string;  // Address of the account: immutable, unique within the service; the value of `account` in calls.',
        '  name: string;  // Human-readable name; it can be renamed.',
        '  identity: string | null;  // Who the account is at the provider, when known.',
        '  status: "connected" | "reauthorization_required" | "pending";  // Only a connected account can act. pending: the sign-in link is not completed yet.',
        '};',
      ].join('\n'),
    );
  });

  it('prints a paged list: an enum, a default, a named type in an array', () => {
    assert.equal(
      signature('notes_list'),
      [
        'notes_list(input: {',
        '  status?: "open" | "done";',
        '  limit?: number;  // [integer, 1..50, default 10]',
        '  cursor?: string;',
        '}): {',
        '  notes: TestNote[];',
        '  nextCursor: string | null;',
        '}',
      ].join('\n'),
    );
  });

  it('prints the conditions between fields and the limits of a field next to its comment', () => {
    assert.equal(
      signature('notes_update'),
      [
        'notes_update(input: {',
        '  // at least one of: title, body',
        '  id: number;  // [integer]',
        '  title?: string;  // [1..80 chars]',
        '  body?: string;  // Markdown.',
        '}): TestNote',
      ].join('\n'),
    );
  });

  it('prints the account field of the platform last, and a field of a named type with its own comment', () => {
    assert.equal(
      signature('mail_send'),
      [
        'mail_send(input: {',
        '  to: string;',
        '  text: string;',
        '  account: string;  // The account to act as.',
        '}): {',
        '  messageId: string;',
        '}',
      ].join('\n'),
    );

    assert.equal(
      signature('export_note'),
      ['export_note(input: {', '  path: WorkspacePath;  // Where the note lies.', '}): FileRef'].join('\n'),
    );
    assert.equal(
      signature('notes_archive_purge'),
      ['notes_archive_purge(input: {}): {', '  purged: number;', '}'].join('\n'),
    );
  });
});
