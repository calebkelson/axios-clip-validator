ALTER TABLE youtube_channels
  ADD COLUMN IF NOT EXISTS sync_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_synced_published_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sync_summary jsonb;

CREATE INDEX IF NOT EXISTS youtube_channels_sync_idx
  ON youtube_channels(sync_status, sync_started_at);
