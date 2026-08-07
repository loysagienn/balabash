-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "thread_id" TEXT;

-- AlterTable
ALTER TABLE "external_server_secret_requests" ADD COLUMN     "thread_id" TEXT;

-- AlterTable
ALTER TABLE "oauth_client_requests" ADD COLUMN     "thread_id" TEXT;
