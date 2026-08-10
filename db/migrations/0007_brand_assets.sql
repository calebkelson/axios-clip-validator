CREATE TABLE IF NOT EXISTS brand_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  show text NOT NULL,
  asset_id uuid NOT NULL UNIQUE REFERENCES assets(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brand_assets_active_idx
  ON brand_assets(active, show, created_at DESC);

ALTER TABLE clip_renders
  ADD COLUMN IF NOT EXISTS logo_asset_id uuid REFERENCES brand_assets(id);
