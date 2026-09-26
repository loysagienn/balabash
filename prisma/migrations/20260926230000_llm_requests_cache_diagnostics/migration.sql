-- llm_requests: request purpose ('turn' | 'keepalive' prompt-cache prewarm
-- pings) and the server's prompt-cache diagnostics (comparison_response_id).
-- Additive only: nullable columns, old rows stay null.

-- AlterTable
ALTER TABLE "llm_requests" ADD COLUMN     "cache_diagnostic" TEXT,
ADD COLUMN     "cache_miss_reason" TEXT,
ADD COLUMN     "cache_missed_tokens" INTEGER,
ADD COLUMN     "purpose" TEXT;
