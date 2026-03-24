-- ENG-46: Timeline LOD (Level of Detail) table
CREATE TABLE IF NOT EXISTS timelines (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  date            DATE NOT NULL,
  chapter         TEXT NOT NULL,
  index_text      TEXT NOT NULL,
  summary_text    TEXT NOT NULL,
  standard_text   TEXT NOT NULL,
  events          JSONB NOT NULL DEFAULT '[]',
  decisions       JSONB NOT NULL DEFAULT '[]',
  open_threads    JSONB NOT NULL DEFAULT '[]',
  people          TEXT[] NOT NULL DEFAULT '{}',
  mood            TEXT,
  significance    DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  memory_ids      TEXT[] NOT NULL DEFAULT '{}',
  summary_embedding vector(1536),
  llm_calls       INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UNIQUE constraint for upsert safety (one timeline per agent per date)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'timelines_agent_id_date_key'
  ) THEN
    ALTER TABLE timelines ADD CONSTRAINT timelines_agent_id_date_key UNIQUE (agent_id, date);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_timelines_user_date ON timelines(user_id, date);
CREATE INDEX IF NOT EXISTS idx_timelines_agent_date ON timelines(agent_id, date DESC);
