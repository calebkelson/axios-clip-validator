ALTER TABLE youtube_videos
  ADD COLUMN IF NOT EXISTS ingestion_job_id uuid REFERENCES processing_jobs(id),
  ADD COLUMN IF NOT EXISTS ingestion_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS ingestion_error text;

CREATE INDEX IF NOT EXISTS youtube_videos_ingestion_queue_idx
  ON youtube_videos(channel_id, ingestion_status, published_at DESC NULLS LAST)
  WHERE ingestion_status IN ('discovered', 'asset_registered');
