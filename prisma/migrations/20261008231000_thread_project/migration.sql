
-- AlterTable
ALTER TABLE "threads" ADD COLUMN     "project_id" TEXT;

-- CreateIndex
CREATE INDEX "threads_user_id_project_id_idx" ON "threads"("user_id", "project_id");

