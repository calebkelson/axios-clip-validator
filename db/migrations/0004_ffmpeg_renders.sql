ALTER TABLE clip_renders
  ADD COLUMN IF NOT EXISTS profile text NOT NULL DEFAULT 'vertical_reel'
    CHECK (profile IN ('vertical_reel', 'square', 'landscape')),
  ADD COLUMN IF NOT EXISTS caption_mode text NOT NULL DEFAULT 'burned'
    CHECK (caption_mode IN ('none', 'sidecar', 'burned')),
  ADD COLUMN IF NOT EXISTS include_logo boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS progress integer NOT NULL DEFAULT 0
    CHECK (progress BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS error text,
  ADD COLUMN IF NOT EXISTS render_manifest jsonb,
  ADD COLUMN IF NOT EXISTS caption_asset_id uuid REFERENCES assets(id),
  ADD COLUMN IF NOT EXISTS thumbnail_asset_id uuid REFERENCES assets(id),
  ADD COLUMN IF NOT EXISTS manifest_asset_id uuid REFERENCES assets(id),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS clip_renders_claim_idx
  ON clip_renders(status, lease_expires_at, created_at);

CREATE INDEX IF NOT EXISTS clip_renders_candidate_idx
  ON clip_renders(candidate_id, created_at DESC);
