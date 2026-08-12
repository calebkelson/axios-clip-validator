CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS clip_candidates_search_text_trgm_idx
  ON clip_candidates USING gin (
    lower(concat_ws(' ',
      COALESCE(social_copy->>'headline', ''),
      COALESCE(social_copy->>'hook', ''),
      COALESCE(social_copy->>'caption', ''),
      COALESCE(social_copy->>'hashtags', ''),
      COALESCE(evidence::text, ''),
      COALESCE(metadata::text, '')
    )) gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS media_sources_search_text_trgm_idx
  ON media_sources USING gin (
    lower(concat_ws(' ',
      COALESCE(uri, ''),
      COALESCE(metadata->>'title', ''),
      COALESCE(metadata->>'name', ''),
      COALESCE(metadata->>'channelName', '')
    )) gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS youtube_videos_search_text_trgm_idx
  ON youtube_videos USING gin (lower(concat_ws(' ', COALESCE(title, ''), COALESCE(description, ''))) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS transcripts_full_text_trgm_idx
  ON transcripts USING gin (lower(COALESCE(full_text, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS transcript_segments_text_trgm_idx
  ON transcript_segments USING gin (lower(text) gin_trgm_ops);
