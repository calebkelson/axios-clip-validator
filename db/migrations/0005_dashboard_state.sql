ALTER TABLE clip_candidates
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS posted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS posted_at timestamptz,
  ADD COLUMN IF NOT EXISTS posted_by text;

CREATE INDEX IF NOT EXISTS clip_candidates_posted_idx
  ON clip_candidates(posted, created_at DESC);
