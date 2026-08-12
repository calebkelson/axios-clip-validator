ALTER TABLE assets
  DROP CONSTRAINT IF EXISTS assets_role_check;

ALTER TABLE assets
  ADD CONSTRAINT assets_role_check
  CHECK (role IN ('source', 'preview', 'transcript', 'render', 'other'));

CREATE INDEX IF NOT EXISTS assets_preview_source_idx
  ON assets(source_id, created_at DESC)
  WHERE role = 'preview';
