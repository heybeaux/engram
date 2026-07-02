-- Delegation Ledger: append-only lifecycle events, Lattice validation evidence,
-- and Receipt proof-of-work artifacts for delegated agent tasks.

CREATE TYPE "DelegationEventType" AS ENUM (
  'CONTRACT_CREATED',
  'CONTRACT_ACCEPTED',
  'CONTRACT_STARTED',
  'CONTRACT_COMPLETED',
  'CONTRACT_VERIFIED',
  'CONTRACT_REJECTED',
  'TASK_ASSIGNED',
  'TASK_STARTED',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'HANDOFF_VALIDATED',
  'RECEIPT_ATTACHED',
  'TRUST_SCORED',
  'CHALLENGE_RAISED',
  'AOP_EVENT_RECORDED'
);

CREATE TYPE "DelegationEventSource" AS ENUM (
  'ENGRAM',
  'SONDER',
  'LATTICE',
  'RECEIPTS',
  'OPENCLAW'
);

CREATE TABLE "delegation_events" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "contract_id" TEXT,
  "task_id" TEXT,
  "agent_session_key" TEXT,
  "event_type" "DelegationEventType" NOT NULL,
  "agent_id" TEXT,
  "parent_event_id" TEXT,
  "trace_id" TEXT,
  "source" "DelegationEventSource" NOT NULL DEFAULT 'ENGRAM',
  "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "delegation_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "delegation_validations" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "contract_id" TEXT NOT NULL,
  "task_id" TEXT,
  "lattice_contract_id" TEXT,
  "trace_id" TEXT,
  "passed" BOOLEAN NOT NULL,
  "tier" TEXT NOT NULL,
  "tiers_run" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "duration_ms" INTEGER,
  "reason" TEXT,
  "confidence" DOUBLE PRECISION,
  "provider_failure" BOOLEAN NOT NULL DEFAULT false,
  "evidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "state_contract" JSONB NOT NULL,
  "validation_result" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "delegation_validations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "delegation_receipts" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "contract_id" TEXT,
  "task_id" TEXT,
  "receipt_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "claim_summary" TEXT NOT NULL,
  "actor_id" TEXT,
  "actor_model" TEXT,
  "verification_summary" TEXT,
  "checks" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "risk_level" TEXT,
  "artifact_uri" TEXT,
  "payload_hash" TEXT,
  "artifact_hashes" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "receipt" JSONB NOT NULL,
  "integrity_status" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "delegation_receipts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "delegation_events_user_id_created_at_idx" ON "delegation_events"("user_id", "created_at");
CREATE INDEX "delegation_events_contract_id_created_at_idx" ON "delegation_events"("contract_id", "created_at");
CREATE INDEX "delegation_events_task_id_created_at_idx" ON "delegation_events"("task_id", "created_at");
CREATE INDEX "delegation_events_agent_id_created_at_idx" ON "delegation_events"("agent_id", "created_at");
CREATE INDEX "delegation_events_trace_id_idx" ON "delegation_events"("trace_id");
CREATE INDEX "delegation_events_event_type_idx" ON "delegation_events"("event_type");

CREATE INDEX "delegation_validations_user_id_created_at_idx" ON "delegation_validations"("user_id", "created_at");
CREATE INDEX "delegation_validations_contract_id_created_at_idx" ON "delegation_validations"("contract_id", "created_at");
CREATE INDEX "delegation_validations_task_id_created_at_idx" ON "delegation_validations"("task_id", "created_at");
CREATE INDEX "delegation_validations_lattice_contract_id_idx" ON "delegation_validations"("lattice_contract_id");
CREATE INDEX "delegation_validations_trace_id_idx" ON "delegation_validations"("trace_id");
CREATE INDEX "delegation_validations_passed_idx" ON "delegation_validations"("passed");

CREATE UNIQUE INDEX "delegation_receipts_user_id_receipt_id_key" ON "delegation_receipts"("user_id", "receipt_id");
CREATE INDEX "delegation_receipts_user_id_created_at_idx" ON "delegation_receipts"("user_id", "created_at");
CREATE INDEX "delegation_receipts_contract_id_created_at_idx" ON "delegation_receipts"("contract_id", "created_at");
CREATE INDEX "delegation_receipts_task_id_created_at_idx" ON "delegation_receipts"("task_id", "created_at");
CREATE INDEX "delegation_receipts_status_idx" ON "delegation_receipts"("status");

ALTER TABLE "delegation_events" ADD CONSTRAINT "delegation_events_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "delegation_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "delegation_events" ADD CONSTRAINT "delegation_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "delegated_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "delegation_validations" ADD CONSTRAINT "delegation_validations_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "delegation_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delegation_validations" ADD CONSTRAINT "delegation_validations_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "delegated_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "delegation_receipts" ADD CONSTRAINT "delegation_receipts_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "delegation_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "delegation_receipts" ADD CONSTRAINT "delegation_receipts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "delegated_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "delegation_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "delegation_events" FOR ALL USING (
  rls_account_id() IS NULL OR "user_id" IN (SELECT rls_user_ids())
);

ALTER TABLE "delegation_validations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "delegation_validations" FOR ALL USING (
  rls_account_id() IS NULL OR "user_id" IN (SELECT rls_user_ids())
);

ALTER TABLE "delegation_receipts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "delegation_receipts" FOR ALL USING (
  rls_account_id() IS NULL OR "user_id" IN (SELECT rls_user_ids())
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'engram_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "delegation_events" TO engram_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "delegation_validations" TO engram_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "delegation_receipts" TO engram_app;
  END IF;
END
$$;
