-- HEY-394: Add inbound_emails table for email integration

CREATE TABLE "inbound_emails" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT,
    "text_body" TEXT,
    "html_body" TEXT,
    "raw_headers" JSONB,
    "resend_event_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbound_emails_pkey" PRIMARY KEY ("id")
);

-- Unique constraint for idempotency
CREATE UNIQUE INDEX "inbound_emails_resend_event_id_key" ON "inbound_emails"("resend_event_id");

-- Indexes
CREATE INDEX "inbound_emails_from_idx" ON "inbound_emails"("from");
CREATE INDEX "inbound_emails_to_idx" ON "inbound_emails"("to");
CREATE INDEX "inbound_emails_created_at_idx" ON "inbound_emails"("created_at");
CREATE INDEX "inbound_emails_status_idx" ON "inbound_emails"("status");
