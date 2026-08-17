CREATE TABLE IF NOT EXISTS trend_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'combined',
  region text NOT NULL DEFAULT 'US',
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trend_snapshots_latest_idx
  ON trend_snapshots (source, region, captured_at DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS trend_topics (
  snapshot_id uuid NOT NULL REFERENCES trend_snapshots(id) ON DELETE CASCADE,
  topic text NOT NULL,
  keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary text NOT NULL,
  rank integer NOT NULL CHECK (rank > 0),
  previous_rank integer CHECK (previous_rank IS NULL OR previous_rank > 0),
  movement text NOT NULL DEFAULT 'new' CHECK (movement IN ('up', 'down', 'steady', 'new')),
  signal_strength numeric CHECK (signal_strength IS NULL OR (signal_strength >= 0 AND signal_strength <= 100)),
  matching_clip_count integer CHECK (matching_clip_count IS NULL OR matching_clip_count >= 0),
  daily_recommendation boolean NOT NULL DEFAULT false,
  source_labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (snapshot_id, topic),
  CHECK (jsonb_typeof(keywords) = 'array'),
  CHECK (jsonb_typeof(source_labels) = 'array'),
  CHECK (jsonb_typeof(evidence_urls) = 'array')
);

CREATE INDEX IF NOT EXISTS trend_topics_topic_idx
  ON trend_topics (topic);
