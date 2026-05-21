-- Migration: pool_grant_agent_id
-- Adds persistent agent-level grants to memory pools.
-- agentSessionId becomes nullable; agentId is added as an alternative FK.

-- 1. Make agent_session_id nullable
ALTER TABLE pool_grants ALTER COLUMN agent_session_id DROP NOT NULL;

-- 2. Add agent_id column (nullable FK to agents)
ALTER TABLE pool_grants ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE;

-- 3. Unique index for (pool_id, agent_id) — PostgreSQL NULLS DISTINCT means NULL rows don't conflict
CREATE UNIQUE INDEX pool_grants_pool_id_agent_id_key ON pool_grants(pool_id, agent_id);

-- 4. Index for efficient agent-scoped grant lookups
CREATE INDEX pool_grants_agent_id_idx ON pool_grants(agent_id);
