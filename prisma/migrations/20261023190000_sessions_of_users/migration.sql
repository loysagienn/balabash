-- A web session is one user's, born of a code with a known source: a row
-- without either is no session (session.ts) — gone, with the workspaces it
-- was signed in to. The operator's name of the time before users is read
-- by nothing.
DELETE FROM "web_session_workspaces" WHERE "login_source" IS NULL OR "session_id" IN (SELECT "id" FROM "web_sessions" WHERE "user_id" IS NULL OR "login_source" IS NULL);
DELETE FROM "web_sessions" WHERE "user_id" IS NULL OR "login_source" IS NULL;

-- AlterTable
ALTER TABLE "web_session_workspaces" ALTER COLUMN "login_source" SET NOT NULL;

-- AlterTable
ALTER TABLE "web_sessions" ALTER COLUMN "login_source" SET NOT NULL,
ALTER COLUMN "user_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "workspaces" DROP COLUMN "operator_name";
