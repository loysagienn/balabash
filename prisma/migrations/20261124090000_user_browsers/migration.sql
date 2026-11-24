-- The browsers users link to the installation through the extension, and
-- the workspaces each is enabled in (src/browser-link). Additive: two new
-- tables nothing else references.
-- CreateTable
CREATE TABLE "user_browsers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "extension_version" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_browsers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_browser_workspaces" (
    "browser_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_browser_workspaces_pkey" PRIMARY KEY ("browser_id","workspace_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_browsers_secret_hash_key" ON "user_browsers"("secret_hash");

-- CreateIndex
CREATE UNIQUE INDEX "user_browsers_user_id_name_key" ON "user_browsers"("user_id", "name");

-- CreateIndex
CREATE INDEX "user_browser_workspaces_workspace_id_idx" ON "user_browser_workspaces"("workspace_id");
