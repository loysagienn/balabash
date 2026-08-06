-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "event_consumers" (
    "name" TEXT NOT NULL,
    "last_seq" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_consumers_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "events" (
    "seq" BIGSERIAL NOT NULL,
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "agent_name" TEXT,
    "user_id" TEXT,
    "thread_id" TEXT,
    "target_thread_id" TEXT,
    "payload" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "threads" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "agent" TEXT NOT NULL,
    "title" TEXT,
    "status" TEXT NOT NULL,
    "summary" JSONB,
    "created_seq" BIGINT NOT NULL,
    "terminal_seq" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_groups" (
    "chat_id" BIGINT NOT NULL,
    "user_id" TEXT,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_groups_pkey" PRIMARY KEY ("chat_id")
);

-- CreateTable
CREATE TABLE "telegram_topics" (
    "thread_id" TEXT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "message_thread_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_topics_pkey" PRIMARY KEY ("thread_id")
);

-- CreateTable
CREATE TABLE "telegram_deliveries" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "message_thread_id" INTEGER,
    "message_id" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "web_sessions" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used" TIMESTAMP(3),
    "user_agent" TEXT,
    "user_id" TEXT,
    "language" TEXT,
    "token_hash" TEXT,
    "rotated_at" TIMESTAMP(3),

    CONSTRAINT "web_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "server" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "connect_nonce" TEXT,
    "pending_state" TEXT,
    "pending" JSONB,
    "tokens" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_clients" (
    "server" TEXT NOT NULL,
    "client_information" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("server")
);

-- CreateTable
CREATE TABLE "oauth_client_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "server" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_client_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_server_secrets" (
    "server" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_server_secrets_pkey" PRIMARY KEY ("server","key")
);

-- CreateTable
CREATE TABLE "external_server_secret_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "server" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_server_secret_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_requests" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT NOT NULL,
    "thread_id" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "response_id" TEXT,
    "previous_response_id" TEXT,
    "last_seq" BIGINT,
    "iteration" INTEGER,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "service_tier" TEXT,
    "duration_ms" INTEGER,
    "input_tokens" INTEGER,
    "cached_tokens" INTEGER,
    "cache_write_tokens" INTEGER,
    "output_tokens" INTEGER,
    "reasoning_tokens" INTEGER,
    "total_tokens" INTEGER,
    "raw_usage" JSONB,

    CONSTRAINT "llm_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "user_id" TEXT,
    "content_type" TEXT,
    "size_bytes" INTEGER,
    "etag" TEXT,
    "original_filename" TEXT,
    "scope" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "uploaded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "events_id_key" ON "events"("id");

-- CreateIndex
CREATE INDEX "events_thread_id_seq_idx" ON "events"("thread_id", "seq");

-- CreateIndex
CREATE INDEX "events_target_thread_id_seq_idx" ON "events"("target_thread_id", "seq");

-- CreateIndex
CREATE INDEX "events_user_id_seq_idx" ON "events"("user_id", "seq");

-- CreateIndex
CREATE INDEX "events_type_seq_idx" ON "events"("type", "seq");

-- CreateIndex
CREATE INDEX "threads_user_id_status_idx" ON "threads"("user_id", "status");

-- CreateIndex
CREATE INDEX "threads_parent_id_status_idx" ON "threads"("parent_id", "status");

-- CreateIndex
CREATE INDEX "threads_user_id_parent_id_idx" ON "threads"("user_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_groups_user_id_key" ON "telegram_groups"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_topics_chat_id_message_thread_id_key" ON "telegram_topics"("chat_id", "message_thread_id");

-- CreateIndex
CREATE INDEX "telegram_deliveries_event_id_idx" ON "telegram_deliveries"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "web_sessions_token_hash_key" ON "web_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "web_sessions_user_id_idx" ON "web_sessions"("user_id");

-- CreateIndex
CREATE INDEX "web_sessions_last_used_idx" ON "web_sessions"("last_used");

-- CreateIndex
CREATE INDEX "web_sessions_created_at_idx" ON "web_sessions"("created_at");

-- CreateIndex
CREATE INDEX "web_sessions_rotated_at_idx" ON "web_sessions"("rotated_at");

-- CreateIndex
CREATE INDEX "web_sessions_last_used_created_at_idx" ON "web_sessions"("last_used", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "connections_connect_nonce_key" ON "connections"("connect_nonce");

-- CreateIndex
CREATE UNIQUE INDEX "connections_pending_state_key" ON "connections"("pending_state");

-- CreateIndex
CREATE UNIQUE INDEX "connections_user_id_server_key" ON "connections"("user_id", "server");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_client_requests_nonce_key" ON "oauth_client_requests"("nonce");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_client_requests_user_id_server_key" ON "oauth_client_requests"("user_id", "server");

-- CreateIndex
CREATE UNIQUE INDEX "external_server_secret_requests_nonce_key" ON "external_server_secret_requests"("nonce");

-- CreateIndex
CREATE UNIQUE INDEX "external_server_secret_requests_user_id_server_key" ON "external_server_secret_requests"("user_id", "server");

-- CreateIndex
CREATE INDEX "llm_requests_user_id_created_at_idx" ON "llm_requests"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "llm_requests_thread_id_created_at_idx" ON "llm_requests"("thread_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "files_bucket_object_key_key" ON "files"("bucket", "object_key");

