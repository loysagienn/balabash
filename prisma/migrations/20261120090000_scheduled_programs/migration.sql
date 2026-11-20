-- Scheduled programs (src/schedule): a task of kind 'program' keeps its code
-- in its own row, every task carries the flag `wake`, and every run of a
-- program is a row of the journal of scheduled runs. Additive: two columns
-- (one nullable, one with a default) and a new table nothing else
-- references.
-- AlterTable
ALTER TABLE "scheduled_tasks" ADD COLUMN     "code" TEXT,
ADD COLUMN     "wake" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "schedule_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "value" JSONB,
    "has_value" BOOLEAN NOT NULL DEFAULT false,
    "error" JSONB,
    "console" TEXT NOT NULL DEFAULT '',
    "console_truncated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "schedule_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedule_runs_workspace_id_started_at_idx" ON "schedule_runs"("workspace_id", "started_at");

-- CreateIndex
CREATE INDEX "schedule_runs_slug_started_at_idx" ON "schedule_runs"("slug", "started_at");
