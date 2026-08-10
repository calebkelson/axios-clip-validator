ALTER TABLE media_sources
  ADD COLUMN IF NOT EXISTS canonical_url text;

CREATE UNIQUE INDEX IF NOT EXISTS media_sources_canonical_url_idx
  ON media_sources(canonical_url)
  WHERE canonical_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS youtube_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_channel_id text NOT NULL UNIQUE,
  handle text,
  name text,
  uploads_playlist_id text,
  active boolean NOT NULL DEFAULT true,
  sync_status text NOT NULL DEFAULT 'idle'
    CHECK (sync_status IN ('idle', 'running', 'completed', 'failed')),
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS youtube_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_video_id text NOT NULL UNIQUE,
  channel_id uuid REFERENCES youtube_channels(id),
  media_source_id uuid UNIQUE REFERENCES media_sources(id),
  canonical_url text NOT NULL UNIQUE,
  title text NOT NULL,
  description text,
  channel_name text,
  uploader_id text,
  published_at timestamptz,
  upload_date date,
  duration_seconds numeric,
  availability text,
  live_status text,
  thumbnail_url text,
  view_count bigint,
  like_count bigint,
  comment_count bigint,
  archive_path text,
  archive_filename text,
  archive_byte_size bigint,
  ingestion_status text NOT NULL DEFAULT 'discovered'
    CHECK (ingestion_status IN ('discovered', 'archive_available', 'queued', 'downloading', 'asset_registered', 'processing', 'ready', 'failed')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_metadata_sync_at timestamptz,
  raw_provider_payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS youtube_videos_channel_published_idx
  ON youtube_videos(channel_id, published_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS youtube_videos_status_idx
  ON youtube_videos(ingestion_status, published_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS youtube_videos_archive_idx
  ON youtube_videos(archive_path)
  WHERE archive_path IS NOT NULL;

CREATE TABLE IF NOT EXISTS youtube_video_metric_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES youtube_videos(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  view_count bigint,
  like_count bigint,
  comment_count bigint,
  raw_provider_payload jsonb NOT NULL DEFAULT '{}',
  UNIQUE(video_id, observed_at)
);

CREATE INDEX IF NOT EXISTS youtube_video_metrics_time_idx
  ON youtube_video_metric_snapshots(video_id, observed_at DESC);
