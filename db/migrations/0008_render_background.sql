ALTER TABLE clip_renders
  ADD COLUMN IF NOT EXISTS background text NOT NULL DEFAULT 'dark_blue'
    CHECK (background IN ('black', 'white', 'dark_blue', 'blurred'));
