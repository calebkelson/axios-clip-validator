CREATE TABLE IF NOT EXISTS youtube_retention_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_path text NOT NULL,
  source_hash text NOT NULL UNIQUE,
  query_start_date date,
  query_end_date date,
  video_count integer NOT NULL DEFAULT 0,
  row_count integer NOT NULL DEFAULT 0,
  summary jsonb NOT NULL DEFAULT '{}',
  collected_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS youtube_retention_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES youtube_retention_imports(id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES youtube_videos(id) ON DELETE CASCADE,
  segment_number integer NOT NULL,
  elapsed_video_time_ratio double precision NOT NULL,
  segment_start_seconds double precision NOT NULL,
  segment_end_seconds double precision NOT NULL,
  audience_watch_ratio double precision NOT NULL,
  started_watching double precision NOT NULL,
  stopped_watching double precision NOT NULL,
  total_segment_impressions double precision NOT NULL,
  relative_retention_performance double precision NOT NULL,
  query_start_date date,
  query_end_date date,
  raw_provider_payload jsonb NOT NULL DEFAULT '{}',
  UNIQUE(import_id, video_id, segment_number)
);

CREATE INDEX IF NOT EXISTS youtube_retention_points_video_idx
  ON youtube_retention_points(video_id, import_id, segment_number);

CREATE TABLE IF NOT EXISTS youtube_audience_clip_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES youtube_retention_imports(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES clip_candidates(id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES youtube_videos(id) ON DELETE CASCADE,
  start_seconds double precision NOT NULL,
  end_seconds double precision NOT NULL,
  audience_signal double precision NOT NULL,
  rewatch_score double precision NOT NULL,
  retention_score double precision NOT NULL,
  entry_score double precision NOT NULL,
  exit_safety_score double precision NOT NULL,
  confidence double precision NOT NULL,
  confidence_label text NOT NULL,
  total_segment_impressions bigint NOT NULL DEFAULT 0,
  signal jsonb NOT NULL DEFAULT '{}',
  classifications jsonb NOT NULL DEFAULT '[]',
  trend jsonb NOT NULL DEFAULT '{}',
  collected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(import_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS youtube_audience_clip_current_idx
  ON youtube_audience_clip_snapshots(candidate_id, collected_at DESC);

CREATE TABLE IF NOT EXISTS youtube_audience_moment_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES youtube_retention_imports(id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES youtube_videos(id) ON DELETE CASCADE,
  moment_key text NOT NULL,
  start_seconds double precision NOT NULL,
  end_seconds double precision NOT NULL,
  audience_signal double precision NOT NULL,
  rewatch_score double precision NOT NULL,
  retention_score double precision NOT NULL,
  entry_score double precision NOT NULL,
  exit_safety_score double precision NOT NULL,
  confidence double precision NOT NULL,
  confidence_label text NOT NULL,
  total_segment_impressions bigint NOT NULL DEFAULT 0,
  overlap_percentage double precision NOT NULL DEFAULT 0,
  covered_by_existing_clip boolean NOT NULL DEFAULT false,
  overlapping_clip_ids jsonb NOT NULL DEFAULT '[]',
  signal jsonb NOT NULL DEFAULT '{}',
  classifications jsonb NOT NULL DEFAULT '[]',
  trend jsonb NOT NULL DEFAULT '{}',
  collected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(import_id, video_id, moment_key)
);

CREATE INDEX IF NOT EXISTS youtube_audience_moments_video_idx
  ON youtube_audience_moment_snapshots(video_id, collected_at DESC, start_seconds);
