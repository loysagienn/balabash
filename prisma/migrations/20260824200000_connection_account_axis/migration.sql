-- Account axis on connections (workspace × service × account). Each existing
-- row becomes the sole 'default' account of its server, display-named after
-- the server. Identity columns stay NULL until the identity probe lands.

-- AlterTable
ALTER TABLE "connections"
  ADD COLUMN "account_key" TEXT,
  ADD COLUMN "display_name" TEXT,
  ADD COLUMN "identity" JSONB,
  ADD COLUMN "identity_id" TEXT;

-- Backfill: pre-multi-account rows are the 'default' account of their server.
UPDATE "connections" SET "account_key" = 'default', "display_name" = "server";

ALTER TABLE "connections"
  ALTER COLUMN "account_key" SET NOT NULL,
  ALTER COLUMN "display_name" SET NOT NULL;

-- DropIndex: uniqueness moves from (user, server) to (user, server, account).
DROP INDEX "connections_user_id_server_key";

-- CreateIndex
CREATE UNIQUE INDEX "connections_user_id_server_account_key_key" ON "connections"("user_id", "server", "account_key");

-- CreateIndex: twin guard — one row per provider identity within (user, server);
-- Postgres treats NULLs as distinct, so identity-less rows never conflict.
CREATE UNIQUE INDEX "connections_user_id_server_identity_id_key" ON "connections"("user_id", "server", "identity_id");
