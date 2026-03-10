-- Migration: ENG-10 — Entity Profiles
-- Adds entity_profiles, entity_attributes, and entity_profile_memories tables

-- 1. Create new enums
CREATE TYPE "EntityType" AS ENUM ('PERSON', 'ORGANIZATION', 'PROJECT', 'BRAND', 'PRODUCT', 'LOCATION', 'CONCEPT', 'CUSTOM');
CREATE TYPE "AttributeType" AS ENUM ('STRING', 'DATE', 'NUMBER', 'URL', 'EMAIL', 'PHONE', 'ADDRESS', 'JSON', 'MARKDOWN');
CREATE TYPE "ProfileSource" AS ENUM ('MANUAL', 'IMPORT', 'API', 'AGENT_CREATED');
CREATE TYPE "AttachMethod" AS ENUM ('AUTO_SEMANTIC', 'AUTO_MENTION', 'MANUAL', 'IMPORT');

-- 2. Create entity_profiles table
CREATE TABLE "entity_profiles" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "EntityType" NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "avatar" TEXT,
    "description" TEXT,
    "entity_id" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" "ProfileSource" NOT NULL DEFAULT 'MANUAL',
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "embedding" vector(1536),
    "pool_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "entity_profiles_pkey" PRIMARY KEY ("id")
);

-- 3. Create entity_attributes table
CREATE TABLE "entity_attributes" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "value_type" "AttributeType" NOT NULL DEFAULT 'STRING',
    "category" TEXT,
    "source" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_attributes_pkey" PRIMARY KEY ("id")
);

-- 4. Create entity_profile_memories table
CREATE TABLE "entity_profile_memories" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "relevance_score" DOUBLE PRECISION NOT NULL,
    "attach_method" "AttachMethod" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_profile_memories_pkey" PRIMARY KEY ("id")
);

-- 5. Create unique constraints
CREATE UNIQUE INDEX "entity_profiles_entity_id_key" ON "entity_profiles"("entity_id");
CREATE UNIQUE INDEX "entity_attributes_profile_id_key_source_key" ON "entity_attributes"("profile_id", "key", "source");
CREATE UNIQUE INDEX "entity_profile_memories_profile_id_memory_id_key" ON "entity_profile_memories"("profile_id", "memory_id");

-- 6. Create indexes
CREATE INDEX "entity_profiles_user_id_idx" ON "entity_profiles"("user_id");
CREATE INDEX "entity_profiles_normalized_name_idx" ON "entity_profiles"("normalized_name");
CREATE INDEX "entity_profiles_type_idx" ON "entity_profiles"("type");
CREATE INDEX "entity_attributes_profile_id_idx" ON "entity_attributes"("profile_id");
CREATE INDEX "entity_profile_memories_profile_id_idx" ON "entity_profile_memories"("profile_id");
CREATE INDEX "entity_profile_memories_memory_id_idx" ON "entity_profile_memories"("memory_id");

-- 7. Add foreign keys
ALTER TABLE "entity_profiles" ADD CONSTRAINT "entity_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "entity_profiles" ADD CONSTRAINT "entity_profiles_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "entity_profiles" ADD CONSTRAINT "entity_profiles_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "memory_pools"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "entity_attributes" ADD CONSTRAINT "entity_attributes_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "entity_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "entity_profile_memories" ADD CONSTRAINT "entity_profile_memories_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "entity_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "entity_profile_memories" ADD CONSTRAINT "entity_profile_memories_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 8. RLS policies
ALTER TABLE entity_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON entity_profiles FOR ALL USING (
  rls_account_id() IS NULL
  OR user_id IN (SELECT rls_user_ids())
);

ALTER TABLE entity_attributes ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON entity_attributes FOR ALL USING (
  rls_account_id() IS NULL
  OR profile_id IN (SELECT id FROM entity_profiles WHERE user_id IN (SELECT rls_user_ids()))
);

ALTER TABLE entity_profile_memories ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON entity_profile_memories FOR ALL USING (
  rls_account_id() IS NULL
  OR profile_id IN (SELECT id FROM entity_profiles WHERE user_id IN (SELECT rls_user_ids()))
);
