CREATE TABLE "dream_cycle_stage_runs" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STARTED',
    "rows_touched" INTEGER,
    "total_rows" INTEGER,
    "error_msg" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    CONSTRAINT "dream_cycle_stage_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "dream_cycle_stage_runs_run_id_idx" ON "dream_cycle_stage_runs"("run_id");
CREATE INDEX "dream_cycle_stage_runs_stage_started_at_idx" ON "dream_cycle_stage_runs"("stage", "started_at");
CREATE INDEX "dream_cycle_stage_runs_started_at_idx" ON "dream_cycle_stage_runs"("started_at");
