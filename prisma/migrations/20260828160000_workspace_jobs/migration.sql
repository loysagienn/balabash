-- Workspace jobs (kind 'command' scheduled tasks): per-kind columns on the
-- registry + the JobRun journal. Additive only.

-- AlterTable
ALTER TABLE "scheduled_tasks" ADD COLUMN     "command" TEXT,
ADD COLUMN     "cwd" TEXT,
ADD COLUMN     "report_on_success" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "timeout_ms" INTEGER;

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "cwd" TEXT,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "exit_code" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "stdout_tail" TEXT NOT NULL DEFAULT '',
    "stderr_tail" TEXT NOT NULL DEFAULT '',
    "stdout_truncated" BOOLEAN NOT NULL DEFAULT false,
    "stderr_truncated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_runs_user_id_started_at_idx" ON "job_runs"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "job_runs_slug_started_at_idx" ON "job_runs"("slug", "started_at");
