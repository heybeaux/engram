-- ENG-44: Add timelines table for Timeline LOD system
-- CreateTable: timelines
CREATE TABLE IF NOT EXISTS "timelines" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentLocalDate" DATE NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "chapter" TEXT NOT NULL,
    "arcId" TEXT,

    "indexText" TEXT NOT NULL,
    "summaryText" TEXT NOT NULL,
    "standardText" TEXT NOT NULL,

    "events" JSONB NOT NULL DEFAULT '[]',
    "decisions" JSONB NOT NULL DEFAULT '[]',
    "openThreadIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    "people" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mood" TEXT,
    "significance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "memoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    "summaryEmbedding" vector(768),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timelines_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one timeline per agent per local date
CREATE UNIQUE INDEX IF NOT EXISTS "timelines_agentId_agentLocalDate_key" ON "timelines"("agentId", "agentLocalDate");

-- Index: agent timelines in reverse chronological order
CREATE INDEX IF NOT EXISTS "timelines_agentId_agentLocalDate_idx" ON "timelines"("agentId", "agentLocalDate" DESC);

-- Index: arc lookups
CREATE INDEX IF NOT EXISTS "timelines_arcId_idx" ON "timelines"("arcId");
