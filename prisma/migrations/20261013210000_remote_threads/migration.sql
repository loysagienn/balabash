-- CreateTable
CREATE TABLE "remote_threads" (
    "thread_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "link" TEXT,
    "cursor" JSONB,
    "watch" JSONB,
    "phase" TEXT NOT NULL DEFAULT 'idle',
    "inbound_seq" BIGINT NOT NULL DEFAULT 0,
    "next_poll_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "poll_failures" INTEGER NOT NULL DEFAULT 0,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "remote_threads_pkey" PRIMARY KEY ("thread_id")
);

-- CreateIndex
CREATE INDEX "remote_threads_kind_ref_idx" ON "remote_threads"("kind", "ref");

-- CreateIndex
CREATE INDEX "remote_threads_phase_next_poll_at_idx" ON "remote_threads"("phase", "next_poll_at");

-- CreateIndex
CREATE INDEX "remote_threads_user_id_phase_idx" ON "remote_threads"("user_id", "phase");

-- One live thread per session: (kind, ref) is unique among the rows whose
-- thread is not over, so a session whose thread ended (cancelled, finished,
-- gone) can be adopted again. Prisma's schema cannot express a partial
-- unique index; this one is by hand and is not in schema.prisma.
CREATE UNIQUE INDEX "remote_threads_kind_ref_live_key" ON "remote_threads"("kind", "ref") WHERE "phase" NOT IN ('closed', 'gone');
