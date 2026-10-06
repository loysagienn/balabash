-- CreateTable
CREATE TABLE "ccr_sessions" (
    "thread_id" TEXT NOT NULL,
    "cse_id" TEXT NOT NULL,
    "seq_cursor" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ccr_sessions_pkey" PRIMARY KEY ("thread_id")
);

-- CreateTable
CREATE TABLE "ccr_deliveries" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "cse_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ccr_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ccr_sessions_cse_id_key" ON "ccr_sessions"("cse_id");

-- CreateIndex
CREATE INDEX "ccr_deliveries_event_id_idx" ON "ccr_deliveries"("event_id");

