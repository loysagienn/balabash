-- Three-level thread self-description: the retrospective description written
-- by the thread's own thread.completed. Additive and backward-compatible.

-- AlterTable
ALTER TABLE "threads" ADD COLUMN     "description" TEXT;
