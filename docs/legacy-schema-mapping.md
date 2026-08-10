# Legacy schema mapping

No importer is included in Phase 1. These tables are migration inputs only.

| Legacy table | Phase 1 destination | Normalization |
|---|---|---|
| `youtube_opus_runs` | `media_sources` + `processing_jobs` | `duration` becomes numeric seconds; `upload_date` becomes `timestamptz`; provider payload archived in `raw_provider_payload`. |
| `youtube_opus_clips` | `clip_candidates` + `clip_renders` + `reviews` | `original_start_sec` and `original_end_sec` become numeric fields; `public_video_url` becomes an `assets` reference; review values become `reviews`. |
| `youtube_opus_status` | `processing_jobs` | Map provider status into durable lifecycle status and retain the original payload in `raw_provider_payload`. |

Only `legacy_provider`, `legacy_project_id`, `legacy_clip_id`, and `legacy_curation_id` retain legacy identity. The excluded analytics, cache, channel, chat, competitor, and agent tables have no Phase 1 mapping.
