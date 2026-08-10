ALTER TABLE clip_renders
  ADD COLUMN IF NOT EXISTS fit_mode text NOT NULL DEFAULT 'cover'
    CHECK (fit_mode IN ('cover', 'contain'));
