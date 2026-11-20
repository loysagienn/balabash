// The five Notion MCP tools exposed by the catalog. The platform supplies the
// account. Only the server's arguments and that account's bearer go on the wire.
import { z } from 'zod';
import {
  accountAuthority,
  capability,
  CapabilityError,
  JsonObject,
  JsonValue,
  namedType,
  node,
  type CallContext,
  type CapabilityDefinition,
} from '../catalog/index.ts';
import { callServerTool, CredentialsRefusedError, type ToolAnswer } from './external-server.ts';

const NOTION_URL = 'https://mcp.notion.com/mcp';

async function callNotion(url: string, tool: string, input: JsonObject, ctx: CallContext): Promise<ToolAnswer> {
  const authority = accountAuthority(ctx);
  const token = await authority.accessToken();
  const send = (access: string) =>
    callServerTool({ title: 'Notion', url, headers: { Authorization: `Bearer ${access}` } }, tool, input, {
      signal: ctx.signal,
    });
  try {
    return await send(token);
  } catch (error) {
    if (!(error instanceof CredentialsRefusedError) || ctx.signal?.aborted) throw error;
    const fresh = await authority.accessToken(token);
    try {
      return await send(fresh);
    } catch (retryError) {
      if (!(retryError instanceof CredentialsRefusedError)) throw retryError;
      throw new CapabilityError(
        'auth_required',
        `Notion refused the renewed token. Re-authorize account "${ctx.account!.account}".`,
      );
    }
  }
}

const dateRange = z.strictObject({
  start_date: z.string().optional(),
  end_date: z.string().optional(),
});
const userFilter = z.array(z.string()).max(100).optional().describe('Use "me" for the connected user.');
const searchInput = z.strictObject({
  query: z.string().describe('Keywords for pages, or a name or email for user lookup.'),
  query_type: z.enum(['internal', 'user']).optional(),
  data_source_url: z.string().optional(),
  page_url: z.string().optional().describe('Restrict the search to this page and its descendants.'),
  teamspace_id: z.string().optional(),
  filters: z
    .strictObject({
      created_date_range: dateRange.optional(),
      created_by_user_ids: userFilter,
      edited_by_user_ids: userFilter,
      last_edited_date_range: dateRange.optional(),
      teamspace_ids: z.array(z.string()).max(100).optional(),
      title_only: z.boolean().optional(),
      content_status: z
        .enum(['all_with_archived', 'all_without_archived', 'verified_only', 'archived_only'])
        .optional(),
    })
    .optional()
    .describe('Dates use YYYY-MM-DD. Notion reports filters omitted on the current plan in notices.'),
  sort: z.enum(['relevance', 'last_edited', 'created']).optional(),
  page_size: z.int().min(1).max(50).optional(),
  max_highlight_length: z.int().min(0).max(500).optional(),
});
const hit = z.strictObject({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  type: z.string(),
  highlight: z.string().nullable(),
  timestamp: z.string().nullable(),
  attributes: JsonObject.describe('Additional Notion search metadata, including path and verification when available.'),
});
const notices = z.array(z.string());
const searchOutput = z.union([
  z.strictObject({ type: z.literal('workspace_search'), results: z.array(hit), notices }),
  z.strictObject({
    type: z.literal('user_search'),
    results: z.array(JsonObject).describe('User lookup records or messages in Notion format.'),
    notices,
  }),
]);

const fetchOutput = z.strictObject({
  metadata: z.object({ type: z.string() }),
  title: z.string(),
  url: z.string(),
  text: z.string().describe('Notion Markdown with properties and ancestor path, or the requested documentation.'),
  attributes: JsonObject.describe(
    'Other fields supplied by Notion, including truncated, unknown_block_count, unknown_block_ids and signed file references when available.',
  ),
});

// Property names and null (clearing a value) belong to the data source's
// schema. These provider-defined maps travel verbatim inside a strict input.
const pageProperties = namedType(
  'NotionPageProperties',
  {
    description: 'Notion property values keyed by their exact names in the data source schema.',
    use: 'verbatim',
  },
  z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string()), z.null()])),
);
const pageAppearance = {
  is_skill: z.boolean().optional().describe('Read notion://docs/skills before marking a page as a skill.'),
  icon: z.string().optional().describe('Use "none" to remove the icon.'),
  cover: z.string().optional().describe('Use "none" to remove the cover.'),
  full_width: z.boolean().optional(),
};
const createInput = z.strictObject({
  pages: z
    .array(
      z.strictObject({
        properties: pageProperties.optional(),
        content: z.string().optional(),
        ...pageAppearance,
        template_id: z
          .string()
          .optional()
          .describe('Supplies the content asynchronously. Omit content when using a template.'),
        preserve_internal_links: z.boolean().optional(),
      }),
    )
    .max(100),
  parent: z
    .union([
      z.literal('memory').describe('Personal memory of the connected user.'),
      z.strictObject({ page_id: z.string(), type: z.literal('page_id').optional() }),
      z.strictObject({ database_id: z.string(), type: z.literal('database_id').optional() }),
      z.strictObject({ data_source_id: z.string(), type: z.literal('data_source_id').optional() }),
      z.strictObject({ teamspace_id: z.string() }),
    ])
    .optional(),
  creation_mode: z.literal('draft').optional(),
});
const created = z.strictObject({
  pages: z.array(z.object({ id: z.string(), url: z.string(), properties: JsonObject })),
});
const updateInput = z.strictObject({
  page_id: z.string(),
  command: z.enum([
    'update_properties',
    'update_content',
    'insert_content',
    'replace_content',
    'apply_template',
    'update_verification',
  ]),
  properties: pageProperties.optional(),
  ...pageAppearance,
  content_updates: z
    .array(
      z.strictObject({
        old_str: z.string().min(1),
        new_str: z.string(),
        replace_all_matches: z.boolean().optional(),
      }),
    )
    .max(100)
    .optional()
    .describe('update_content: exact matches and their replacements, applied in order.'),
  position: z.strictObject({ type: z.enum(['start', 'end']) }).optional(),
  content: z
    .string()
    .optional()
    .describe('insert_content: Markdown to prepend or append. The default position is end.'),
  new_str: z.string().optional().describe('replace_content: the entire new page body, including child tags to retain.'),
  allow_deleting_content: z.boolean().optional().describe('Applies to replace_content and update_content.'),
  template_id: z.string().optional().describe('apply_template: the page template to append asynchronously.'),
  verification_status: z.enum(['verified', 'unverified']).optional(),
  verification_expiry_days: z.int().positive().optional(),
});
const updated = z.strictObject({
  pageId: z.string().nullable(),
  warnings: z.array(JsonValue).describe('Unapplied edits or other warnings from Notion.'),
  asyncTask: JsonObject.nullable().describe('Background task from Notion while the change is being applied.'),
});
const privatePage = z.object({ type: z.string(), url: z.string(), title: z.string() });
const privateList = z.strictObject({ results: z.array(privatePage), nextCursor: z.string().nullable() });

// Validate the fields the catalog uses. A response missing a required field
// is a provider error, even when the write has already taken effect.
export function notionNode(url = NOTION_URL) {
  function leaf({
    project,
    writing = false,
    ...definition
  }: Omit<CapabilityDefinition, 'run'> & {
    project: (answer: JsonObject) => unknown;
    writing?: boolean;
  }) {
    const tool = 'notion-' + definition.name.replaceAll('_', '-');
    return capability({
      ...definition,
      async run(args, ctx) {
        const input = args as JsonObject;
        const answer = await callNotion(url, tool, writing ? { ...input, allow_async: false } : input, ctx);
        const writeHint = writing ? ' Check whether the change took effect before repeating it.' : '';
        let response: JsonValue;
        try {
          response = JsonValue.parse(answer.structured ?? JSON.parse(answer.text));
        } catch {
          throw new CapabilityError('external_error', `Notion answered ${tool} without a JSON object.${writeHint}`);
        }
        if (response === null || typeof response !== 'object' || Array.isArray(response)) {
          throw new CapabilityError(
            'external_error',
            `Notion answered ${tool} without a JSON object.${writeHint}`,
            writing ? response : undefined,
          );
        }
        const parsed = definition.output.safeParse(project(response));
        if (!parsed.success) {
          const path = parsed.error.issues[0]?.path.join('.') || 'the result';
          throw new CapabilityError(
            'external_error',
            `Notion answered ${tool} with unexpected data at ${path}.${writeHint}`,
            writing ? response : undefined,
          );
        }
        return parsed.data;
      },
    });
  }

  return node({
    name: 'notion',
    external: true,
    summary: "Search and read the user's Notion workspace. Create pages and database items, and edit pages.",
    connection: {
      type: 'account',
      service: 'notion',
      oauth: { url, clientRegistration: 'dynamic' },
      summary:
        "Search, read and edit the user's Notion pages and database items. At sign-in the user chooses which pages to share.",
    },
    guide: [
      {
        text: 'Fetch the page with `notion_fetch` before editing unless it is already loaded. Check attributes.truncated before relying on its content. Match its style and make the smallest complete edit.',
      },
      {
        text: 'The title is a property. Write the body in Notion Markdown. For more than plain headings, lists and links, read notion://docs/notion-flavored-markdown-spec with `notion_fetch` first.',
      },
      {
        text: 'For a database item, fetch the database first and use its collection:// data source and exact schema property names, including the title property. Outside a database the only page property is "title".',
      },
      {
        text: 'Notion property formats: dates use "date:{property}:start", ":end" and ":is_datetime" (0 or 1), checkboxes "__YES__" or "__NO__", relations arrays of page URLs or IDs. Prefix a property named "id" or "url" with "userDefined:".',
      },
      {
        text: 'When the user names no destination, create a private draft with creation_mode "draft". Tell the user it is a draft and offer to move it.',
      },
      {
        text: 'If an edit would delete child pages or databases, show the children identified by Notion and get explicit consent before setting allow_deleting_content.',
      },
      {
        text: 'If asyncTask is non-null after an update, or a page uses a template, fetch the page again before depending on the change.',
      },
    ],
    children: [
      leaf({
        name: 'search',
        summary: 'Find pages and databases, or look up a user',
        description:
          'Search pages and databases by keyword, or look up a person by name or email with query_type "user". An empty content query needs filters or a non-relevance sort. Check notices for restrictions of the current plan.',
        input: searchInput,
        output: searchOutput,
        project: answer => ({
          type: answer.type,
          notices: answer.notices ?? [],
          results:
            answer.type === 'workspace_search' && Array.isArray(answer.results)
              ? answer.results.map(result => {
                  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
                  const { id, title, url, type, highlight, timestamp, ...attributes } = result;
                  return {
                    id,
                    title,
                    url,
                    type,
                    highlight: highlight ?? null,
                    timestamp: timestamp ?? null,
                    attributes,
                  };
                })
              : answer.results,
        }),
      }),
      leaf({
        name: 'fetch',
        summary: 'Read a Notion entity or Notion Markdown documentation',
        description:
          'Read a page, database, data source or saved view by URL or ID. Use a notion://docs/ URI to read Notion documentation.',
        input: z.strictObject({
          id: z.string(),
          include_discussions: z.boolean().optional(),
          include_transcript: z.boolean().optional(),
          include_file_urls: z
            .boolean()
            .optional()
            .describe('Include temporary download URLs for uploaded files in the returned attributes.'),
        }),
        output: fetchOutput,
        project: ({ metadata, title, url, text, ...attributes }) => ({ metadata, title, url, text, attributes }),
      }),
      leaf({
        name: 'create_pages',
        summary: 'Create pages under one parent or as private drafts',
        description:
          'Create pages under one parent, or create them all as private drafts. For a database with several data sources, select the intended data_source_id. A template can populate a database item after creation.',
        input: createInput,
        writing: true,
        output: created,
        project: ({ pages }) => ({ pages }),
        inputRules: [{ exactlyOne: ['parent', 'creation_mode'] }],
      }),
      leaf({
        name: 'update_page',
        summary: 'Edit the properties or content of one page',
        description:
          'Edit a page’s properties, appearance or content. Use update_properties for properties or appearance, update_content for targeted replacements, insert_content to prepend or append, or replace_content for the entire body. apply_template takes template_id. update_verification takes verification_status. Check warnings for edits that did not match.',
        input: updateInput,
        writing: true,
        output: updated,
        project: answer =>
          answer.type === 'async_task'
            ? { pageId: null, warnings: [], asyncTask: answer }
            : { pageId: answer.page_id ?? undefined, warnings: answer.warnings ?? [], asyncTask: null },
      }),
      leaf({
        name: 'list_private_pages',
        summary: 'List the top-level pages and databases in the Private sidebar',
        description: 'Browse the connected user’s Private sidebar one page of results at a time.',
        input: z.strictObject({ limit: z.int().min(1).max(200).optional(), cursor: z.string().optional() }),
        output: privateList,
        project: answer => ({ results: answer.results, nextCursor: answer.nextCursor ?? null }),
      }),
    ],
  });
}
