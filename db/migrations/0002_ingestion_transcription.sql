ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'other'
    CHECK (role IN ('source', 'transcript', 'render', 'other'));

CREATE INDEX IF NOT EXISTS assets_source_role_idx
  ON assets(source_id, role, created_at DESC);

CREATE TABLE IF NOT EXISTS source_probes (
  source_id uuid PRIMARY KEY REFERENCES media_sources(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed')),
  content_type text,
  byte_size bigint,
  duration_seconds numeric,
  width integer,
  height integer,
  video_codec text,
  audio_codec text,
  frame_rate numeric,
  probe_json jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS source_probes_status_idx
  ON source_probes(status, updated_at DESC);

ALTER TABLE transcripts
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('processing', 'completed', 'failed')),
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS full_text text,
  ADD COLUMN IF NOT EXISTS duration_seconds numeric,
  ADD COLUMN IF NOT EXISTS error text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS transcripts_job_unique_idx
  ON transcripts(job_id);

CREATE INDEX IF NOT EXISTS transcript_segments_time_idx
  ON transcript_segments(transcript_id, start_seconds, end_seconds);
