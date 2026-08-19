CREATE TABLE IF NOT EXISTS thumbnail_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES clip_candidates(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES media_sources(id),
  frame_seconds numeric NOT NULL CHECK (frame_seconds >= 0),
  source_headline_card_id text,
  brand_asset_id uuid REFERENCES brand_assets(id),
  segmentation_provider text NOT NULL CHECK (segmentation_provider IN ('sam3', 'u2netp')),
  positive_box jsonb,
  negative_boxes jsonb NOT NULL DEFAULT '[]'::jsonb,
  manifest_json jsonb,
  source_frame_asset_id uuid REFERENCES assets(id),
  subject_asset_id uuid REFERENCES assets(id),
  preview_asset_id uuid REFERENCES assets(id),
  export_asset_id uuid REFERENCES assets(id),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'ready', 'export_queued', 'exporting', 'completed', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS thumbnail_projects_candidate_idx
  ON thumbnail_projects(candidate_id, created_at DESC);

CREATE INDEX IF NOT EXISTS thumbnail_projects_status_idx
  ON thumbnail_projects(status, updated_at);

CREATE TABLE IF NOT EXISTS thumbnail_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thumbnail_project_id uuid NOT NULL REFERENCES thumbnail_projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS thumbnail_jobs_claim_idx
  ON thumbnail_jobs(status, lease_expires_at, created_at);

CREATE INDEX IF NOT EXISTS thumbnail_jobs_project_idx
  ON thumbnail_jobs(thumbnail_project_id, created_at DESC);
