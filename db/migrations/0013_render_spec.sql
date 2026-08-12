ALTER TABLE clip_renders
  ADD COLUMN IF NOT EXISTS render_spec jsonb;
