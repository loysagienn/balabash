// Step 3 rewrites only the canonical tool.call journal. Session SDK events
// and JSON nested in a capability's own data are independent records.
import type { Prisma } from '../../prisma-generated/client.ts';

const names = {
  workspace_export_file: 'export_file',
  workspace_import_file: 'import_file',
  remote_fetch_file: 'fetch_thread_file',
  list_threads: 'threads_list',
  get_thread: 'threads_get',
  get_thread_events: 'threads_get_transcript',
  create_task: 'schedule_create_task',
  list_tasks: 'schedule_list_tasks',
  cancel_task: 'schedule_cancel_task',
  run_task: 'schedule_run_task',
  list_job_runs: 'schedule_list_runs',
  get_job_run: 'schedule_get_run',
  request_restart: 'system_request_restart',
  data_query: 'workspace_query',
  workspace_read_file: 'workspace_files_read',
  workspace_write_file: 'workspace_files_write',
  workspace_list_files: 'workspace_files_list',
  workspace_get_file: 'workspace_files_stat',
  workspace_delete_file: 'workspace_files_delete',
  run_script: 'workspace_run_command',
  apps_list: 'workspace_apps_list',
  apps_publish: 'workspace_apps_publish',
  apps_unpublish: 'workspace_apps_unpublish',
  http_get: 'web_get',
  storage_download_file: 'web_download',
  perplexity_search: 'web_perplexity_search',
  perplexity_ask: 'web_perplexity_ask',
  perplexity_reason: 'web_perplexity_reason',
  perplexity_research: 'web_perplexity_research',
  'notion-search': 'notion_search',
  'notion-fetch': 'notion_fetch',
  'notion-create-pages': 'notion_create_pages',
  'notion-update-page': 'notion_update_page',
  'notion-list-private-pages': 'notion_list_private_pages',
  request_authorization: 'connections_authorize',
  request_oauth_client_credentials: 'connections_request_oauth_client',
  request_external_server_credentials: 'connections_request_secret',
  forget_external_server_credentials: 'connections_forget_secret',
  rename_connection: 'connections_rename',
  disconnect_connection: 'connections_disconnect',
};

export async function migrateCalls(tx: Prisma.TransactionClient) {
  // A start has the same shape in both versions. Exclude pairs already
  // written by the new writer (including names belonging to remote tools).
  const renamed = await tx.$executeRaw`
    WITH modern AS MATERIALIZED (
      SELECT thread_id, payload->>'callId' AS call_id FROM events
      WHERE (type = 'tool.call.completed' AND payload ? 'value')
         OR (type = 'tool.call.failed' AND jsonb_typeof(payload->'error') = 'object')
    ), mapped AS (
      SELECT e.seq, e.payload->>'functionName' AS old_name, CASE
        WHEN e.payload->>'functionName' = 'storage_get_file'
          THEN CASE WHEN e.agent_name = 'coordinator' THEN 'view_file' ELSE 'get_file_url' END
        ELSE ${JSON.stringify(names)}::jsonb ->> (e.payload->>'functionName') END AS new_name
      FROM events e
      WHERE (e.type = 'tool.call.completed' AND e.payload ? 'result')
         OR (e.type = 'tool.call.failed' AND jsonb_typeof(e.payload->'error') = 'string')
         OR (e.type = 'tool.call.started' AND NOT EXISTS (
           SELECT 1 FROM modern WHERE thread_id = e.thread_id AND call_id = e.payload->>'callId'))
    )
    UPDATE events e SET payload = jsonb_set(e.payload, '{functionName}', to_jsonb(mapped.new_name))
    FROM mapped WHERE e.seq = mapped.seq AND mapped.old_name <> mapped.new_name`;

  // Preserve jsonb verbatim, including numbers beyond JS integer precision
  // and foreign objects marked kind=file. Only inspect MCP content blocks if
  // structuredContent is absent. Never import binary data into file storage.
  const completed = await tx.$executeRaw`
    WITH outcomes AS MATERIALIZED (
      SELECT seq, payload->'result'->'isError' = 'true'::jsonb AS failed,
        COALESCE(payload->'result'->'structuredContent', (
          SELECT CASE WHEN count(*) = 0 THEN '""'::jsonb
            WHEN bool_and(jsonb_typeof(part) = 'string') THEN to_jsonb(string_agg(part #>> '{}', E'\\n' ORDER BY pos))
            WHEN count(*) = 1 THEN (jsonb_agg(part)->0)
            ELSE jsonb_agg(part ORDER BY pos) END
          FROM (
            SELECT pos, CASE
              WHEN block->>'type' = 'text' THEN block->'text'
              WHEN f.id IS NOT NULL THEN jsonb_build_object('kind','file','id',f.id,'name',f.original_filename,
                'contentType',f.content_type,'sizeBytes',f.size_bytes,'width',f.width,'height',f.height)
              WHEN block->>'type' = 'resource_link' THEN block - 'type'
              WHEN block->>'type' = 'resource' AND block->'resource' ? 'text' THEN block->'resource'->'text'
              ELSE to_jsonb('[' || coalesce(block->>'type','content') || ' omitted]') END AS part
            FROM jsonb_array_elements(payload->'result'->'content') WITH ORDINALITY b(block,pos)
            LEFT JOIN files f ON f.id = block->>'fileId' AND f.workspace_id = e.workspace_id
          ) parts
        )) AS value
      FROM events e WHERE type = 'tool.call.completed' AND payload ? 'result'
    )
    UPDATE events e SET type = CASE WHEN o.failed THEN 'tool.call.failed' ELSE 'tool.call.completed' END,
      payload = (e.payload - 'result' - 'serverName' - 'toolName') || CASE WHEN o.failed
        THEN jsonb_build_object('error', jsonb_build_object('kind','external_error',
          'message', coalesce(o.value #>> '{error,message}', o.value->>'message',
            CASE WHEN jsonb_typeof(o.value) = 'string' THEN o.value #>> '{}' END, 'The MCP tool reported an error.'),
          'details', o.value))
        ELSE jsonb_build_object('value',o.value) END
    FROM outcomes o WHERE e.seq = o.seq`;

  const failures = await tx.$executeRaw`
    UPDATE events SET payload = jsonb_set(payload, '{error}',
      jsonb_build_object('kind','external_error','message',payload->>'error'))
    WHERE type = 'tool.call.failed' AND jsonb_typeof(payload->'error') = 'string'`;
  return { renamed, completed, failures };
}
