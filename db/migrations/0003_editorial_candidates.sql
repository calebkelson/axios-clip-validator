ALTER TABLE clip_candidates
  ADD COLUMN IF NOT EXISTS transcript_id uuid REFERENCES transcripts(id),
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'proposed'
    CHECK (review_status IN ('proposed', 'accepted', 'rejected', 'edited')),
  ADD COLUMN IF NOT EXISTS confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  ADD COLUMN IF NOT EXISTS rationale text,
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS social_copy jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS edited_start_seconds numeric,
  ADD COLUMN IF NOT EXISTS edited_end_seconds numeric,
  ADD COLUMN IF NOT EXISTS reviewed_by text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD CONSTRAINT clip_candidates_edited_window_check
    CHECK (edited_end_seconds IS NULL OR edited_start_seconds IS NULL OR edited_end_seconds >= edited_start_seconds);

CREATE UNIQUE INDEX IF NOT EXISTS clip_candidates_job_window_unique_idx
  ON clip_candidates(job_id, start_seconds, end_seconds);

CREATE INDEX IF NOT EXISTS clip_candidates_review_idx
  ON clip_candidates(review_status, score DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS clip_candidates_transcript_idx
  ON clip_candidates(transcript_id);
