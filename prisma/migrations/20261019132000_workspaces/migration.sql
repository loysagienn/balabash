-- The workspace's table and columns take the name the code has used since
-- the rename of the workspace's "user" to "workspace": users → workspaces,
-- user_id → workspace_id. Renames only — rows, types, defaults and index
-- definitions stay; the index and constraint names follow Prisma's
-- convention so the schema and the migrations agree (`prisma migrate diff`
-- against the schema is empty). The schema has no foreign keys, so nothing
-- else refers to the table. Deliberately NOT additive: a bundle built
-- before this migration cannot run on the renamed schema, and the
-- supervisor's last-good rollback does not cover it — the way back is the
-- reverse of these statements by hand.

-- The table and its primary key (renaming the constraint renames its index).
ALTER TABLE "users" RENAME TO "workspaces";
ALTER TABLE "workspaces" RENAME CONSTRAINT "users_pkey" TO "workspaces_pkey";

-- The columns.
ALTER TABLE "app_publications" RENAME COLUMN "user_id" TO "workspace_id";
ALTER TABLE "connections" RENAME COLUMN "user_id" TO "workspace_id";
ALTER TABLE "events" RENAME COLUMN "user_id" TO "workspace_id";
ALTER TABLE "external_server_secret_requests" RENAME COLUMN "user_id" TO "workspace_id";
ALTER TABLE "files" RENAME COLUMN "user_id" TO "workspace_id";
ALTER TABLE "job_runs" RENAME COLUMN "user_id" TO "workspace_id";
ALTER TABLE "llm_requests" RENAME COLUMN "user_id" TO "workspace_id";
ALTER TABLE "oauth_client_requests" RENAME COLUMN "user_id" TO "workspace_id";
ALTER TABLE "projects" RENAME COLUMN "user_id" TO "workspace_id";
ALTER TABLE "remote_threads" RENAME COLUMN "user_id" TO "workspace_id";
ALTER TABLE "scheduled_tasks" RENAME COLUMN "user_id" TO "workspace_id";
ALTER TABLE "telegram_groups" RENAME COLUMN "user_id" TO "workspace_id";
ALTER TABLE "threads" RENAME COLUMN "user_id" TO "workspace_id";
ALTER TABLE "web_session_workspaces" RENAME COLUMN "user_id" TO "workspace_id";
ALTER TABLE "web_sessions" RENAME COLUMN "user_id" TO "workspace_id";

-- The indexes and unique constraints over those columns
-- (web_session_workspaces_pkey keeps its name: it is named after the table).
ALTER INDEX "app_publications_user_id_path_key" RENAME TO "app_publications_workspace_id_path_key";
ALTER INDEX "connections_user_id_server_account_key_key" RENAME TO "connections_workspace_id_server_account_key_key";
ALTER INDEX "connections_user_id_server_identity_id_key" RENAME TO "connections_workspace_id_server_identity_id_key";
ALTER INDEX "events_user_id_seq_idx" RENAME TO "events_workspace_id_seq_idx";
ALTER INDEX "external_server_secret_requests_user_id_server_key" RENAME TO "external_server_secret_requests_workspace_id_server_key";
ALTER INDEX "job_runs_user_id_started_at_idx" RENAME TO "job_runs_workspace_id_started_at_idx";
ALTER INDEX "llm_requests_user_id_created_at_idx" RENAME TO "llm_requests_workspace_id_created_at_idx";
ALTER INDEX "oauth_client_requests_user_id_server_key" RENAME TO "oauth_client_requests_workspace_id_server_key";
ALTER INDEX "projects_user_id_slug_key" RENAME TO "projects_workspace_id_slug_key";
ALTER INDEX "projects_user_id_title_key" RENAME TO "projects_workspace_id_title_key";
ALTER INDEX "remote_threads_user_id_phase_idx" RENAME TO "remote_threads_workspace_id_phase_idx";
ALTER INDEX "scheduled_tasks_user_id_idx" RENAME TO "scheduled_tasks_workspace_id_idx";
ALTER INDEX "telegram_groups_user_id_key" RENAME TO "telegram_groups_workspace_id_key";
ALTER INDEX "threads_user_id_parent_id_idx" RENAME TO "threads_workspace_id_parent_id_idx";
ALTER INDEX "threads_user_id_project_id_idx" RENAME TO "threads_workspace_id_project_id_idx";
ALTER INDEX "threads_user_id_status_idx" RENAME TO "threads_workspace_id_status_idx";
ALTER INDEX "web_session_workspaces_user_id_idx" RENAME TO "web_session_workspaces_workspace_id_idx";
ALTER INDEX "web_sessions_user_id_idx" RENAME TO "web_sessions_workspace_id_idx";
