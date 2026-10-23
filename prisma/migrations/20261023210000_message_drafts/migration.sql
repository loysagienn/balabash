-- A user's unsent message of a thread, one row per (user, thread): the
-- composer's draft as last saved from any device, with the revision every
-- write names (src/drafts). Additive: a new table nothing else references.
-- CreateTable
CREATE TABLE "message_drafts" (
    "user_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "file_ids" TEXT[],
    "revision" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_session" TEXT,

    CONSTRAINT "message_drafts_pkey" PRIMARY KEY ("user_id","thread_id")
);

-- CreateIndex
CREATE INDEX "message_drafts_thread_id_idx" ON "message_drafts"("thread_id");

