ALTER TABLE thumbnail_projects
  ADD COLUMN IF NOT EXISTS protected_boxes jsonb NOT NULL DEFAULT '[]'::jsonb;
