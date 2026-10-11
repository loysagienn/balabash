-- CreateTable
CREATE TABLE "web_session_workspaces" (
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "login_source" TEXT,

    CONSTRAINT "web_session_workspaces_pkey" PRIMARY KEY ("session_id","user_id")
);

-- CreateIndex
CREATE INDEX "web_session_workspaces_user_id_idx" ON "web_session_workspaces"("user_id");

-- Every existing session is signed in to the one workspace it was born for.
INSERT INTO "web_session_workspaces" ("session_id", "user_id", "created_at", "login_source")
SELECT "id", "user_id", "created_at", "login_source" FROM "web_sessions" WHERE "user_id" IS NOT NULL;
