ALTER TABLE "events"
  ADD COLUMN "task_slug" TEXT,
  ADD COLUMN "task_run_id" TEXT;

ALTER TABLE "oauth_client_requests" ADD COLUMN "task_slug" TEXT;
ALTER TABLE "external_server_secret_requests" ADD COLUMN "task_slug" TEXT;
