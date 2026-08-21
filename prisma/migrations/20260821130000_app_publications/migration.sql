-- Registry of app publications (apps platform, step 4). Additive only: the
-- diff against the live database also proposed dropping legacy ccr_* tables
-- that are outside the schema — deliberately NOT included here.

-- CreateTable
CREATE TABLE "app_publications" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_publications_slug_key" ON "app_publications"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "app_publications_user_id_path_key" ON "app_publications"("user_id", "path");
