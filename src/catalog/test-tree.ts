// A small tree for the tests of the catalog: root capabilities, a plain node
// with a sub-node, a node under an account connection (with a sub-node that
// inherits it) and a node under a secret connection.

import { z } from 'zod';
import { buildCatalog, type Catalog } from './catalog.ts';
import { capability, node, type CallContext, type RootDefinition } from './definition.ts';
import { CapabilityError } from './errors.ts';
import type { ConnectionsPort } from './grant.ts';
import { FileRef, WorkspacePath, namedType, type AccountValue } from './types.ts';

export const TestNote = namedType(
  'TestNote',
  { description: 'One note of the test tree.' },
  z.strictObject({
    id: z.int(),
    title: z.string(),
    body: z.string().nullable().describe('null for an empty note.'),
    attachment: FileRef.nullable(),
  }),
);

const NOTE = { id: 1, title: 'First', body: null, attachment: null };

// What the actions of the tree were called with, for the tests to look at.
export type Calls = Array<{ name: string; input: unknown; ctx: CallContext }>;

export function testRoot(calls: Calls = []): RootDefinition {
  const record = (name: string, input: unknown, ctx: CallContext) => calls.push({ name, input, ctx });

  return {
    summary: 'Everything the test platform can do.',
    guide: [
      { text: 'Open a vertex with `describe`.', requires: ['describe'] },
      { text: 'Call an open capability through `call`.', requires: ['call'] },
      { text: 'Leave an optional field out.' },
      { text: 'Any note reads in full with `get_note`.', requires: ['get_note'] },
      { text: 'A note becomes a file with `export_note`.', requires: ['export_note'] },
    ],
    children: [
      capability({
        name: 'get_note',
        summary: 'Load one note by its id',
        description: 'Load one note by its id.',
        input: z.strictObject({ id: z.int() }),
        output: TestNote,
        run(input, ctx) {
          record('get_note', input, ctx);

          if (input.id === 404) {
            throw new CapabilityError('not_found', 'No note 404.', { id: 404 });
          }

          if (input.id === 500) {
            throw new TypeError('boom');
          }

          if (input.id === 13) {
            return { id: 13 } as never;
          }

          return { ...NOTE, id: input.id };
        },
      }),
      capability({
        name: 'export_note',
        summary: 'Store a note as a file and get its reference',
        description: 'Store a note as a file of the storage.',
        input: z.strictObject({ path: WorkspacePath.describe('Where the note lies.') }),
        output: FileRef,
        run(input, ctx) {
          record('export_note', input, ctx);

          return {
            kind: 'file' as const,
            id: 'file-1',
            name: 'note.md',
            contentType: 'text/markdown',
            sizeBytes: 12,
            width: null,
            height: null,
          };
        },
      }),
      node({
        name: 'notes',
        summary: 'The notes of the workspace. Come here to find or change a note.',
        guide: [
          { text: 'Find a note with `notes_list`, then change it with `notes_update`.' },
          { text: 'A found note reads in full with `get_note`.', requires: ['get_note'] },
        ],
        children: [
          capability({
            name: 'list',
            summary: 'List the notes, newest first',
            description: 'List the notes of the workspace, newest first.',
            input: z.strictObject({
              status: z.enum(['open', 'done']).optional(),
              limit: z.int().min(1).max(50).default(10),
              cursor: z.string().optional(),
            }),
            output: z.strictObject({ notes: z.array(TestNote), nextCursor: z.string().nullable() }),
            run(input, ctx) {
              record('notes_list', input, ctx);

              return { notes: [NOTE], nextCursor: null };
            },
          }),
          capability({
            name: 'update',
            summary: 'Change the title or the body of a note',
            description: 'Change a note. Fields left out stay as they are.',
            input: z.strictObject({
              id: z.int(),
              title: z.string().min(1).max(80).optional(),
              body: z.string().describe('Markdown.').optional(),
            }),
            inputRules: [{ atLeastOne: ['title', 'body'] }],
            output: TestNote,
            run(input, ctx) {
              record('notes_update', input, ctx);

              return { ...NOTE, id: input.id, title: input.title ?? NOTE.title, body: input.body ?? null };
            },
          }),
          node({
            name: 'archive',
            summary: 'The archive of notes. Come here to clean it.',
            children: [
              capability({
                name: 'purge',
                summary: 'Delete every archived note',
                description: 'Delete every archived note for good.',
                input: z.strictObject({}),
                output: z.strictObject({ purged: z.int() }),
                run(input, ctx) {
                  record('notes_archive_purge', input, ctx);

                  return { purged: 0 };
                },
              }),
            ],
          }),
        ],
      }),
      node({
        name: 'mail',
        summary: "The user's mail. Come here to send a letter.",
        connection: { type: 'account', service: 'mail', summary: 'Mail of the user.' },
        children: [
          capability({
            name: 'send',
            summary: 'Send a plain-text letter',
            description: 'Send a plain-text letter from the account.',
            input: z.strictObject({ to: z.string(), text: z.string() }),
            output: z.strictObject({ messageId: z.string() }),
            run(input, ctx) {
              record('mail_send', input, ctx);

              return { messageId: `from-${ctx.account?.account}` };
            },
          }),
          node({
            name: 'labels',
            summary: 'The labels of the mailbox.',
            children: [
              capability({
                name: 'list',
                summary: 'List the labels of the mailbox',
                description: 'List the labels of the mailbox.',
                input: z.strictObject({}),
                output: z.strictObject({ labels: z.array(z.string()) }),
                run(input, ctx) {
                  record('mail_labels_list', input, ctx);

                  return { labels: [] };
                },
              }),
            ],
          }),
        ],
      }),
      node({
        name: 'search',
        summary: 'Search of the web. Come here to find a page.',
        connection: { type: 'secret', service: 'search', summary: 'Web search.' },
        children: [
          capability({
            name: 'query',
            summary: 'Search the web',
            description: 'Search the web and get the addresses found.',
            input: z.strictObject({ text: z.string() }),
            output: z.strictObject({ urls: z.array(z.string()) }),
            run(input, ctx) {
              record('search_query', input, ctx);

              return { urls: [] };
            },
          }),
        ],
      }),
    ],
  };
}

export function testCatalog(calls: Calls = []): Catalog {
  return buildCatalog(testRoot(calls)).catalog;
}

export const WORK: AccountValue = { account: 'work', name: 'Work', identity: 'me@work.test', status: 'connected' };
export const OLD: AccountValue = { account: 'old', name: 'Old', identity: null, status: 'reauthorization_required' };

export function testConnections(
  state: { accounts?: Record<string, AccountValue[]>; secrets?: string[] } = {},
): ConnectionsPort {
  return {
    async accounts(_workspaceId, service) {
      return state.accounts?.[service] ?? [];
    },
    async secretsReady(service) {
      return (state.secrets ?? []).includes(service);
    },
  };
}

export const CALLER = { workspaceId: 'workspace-1', threadId: 'thread-1', agentName: 'tester' };
