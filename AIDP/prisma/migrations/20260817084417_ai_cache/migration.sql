-- CreateTable
CREATE TABLE "ai_cache" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "vector" vector(1024),
    "payload" JSONB,
    "costTokens" INTEGER NOT NULL DEFAULT 0,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_cache_organisationId_lastUsedAt_idx" ON "ai_cache"("organisationId", "lastUsedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_cache_organisationId_kind_fingerprint_key" ON "ai_cache"("organisationId", "kind", "fingerprint");

-- AddForeignKey
ALTER TABLE "ai_cache" ADD CONSTRAINT "ai_cache_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
