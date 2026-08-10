ALTER TABLE clip_renders
  ADD COLUMN IF NOT EXISTS logo_position text NOT NULL DEFAULT 'top-left'
    CHECK (logo_position IN ('top-left', 'top-center', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right'));
