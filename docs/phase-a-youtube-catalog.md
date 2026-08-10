# Phase A YouTube Catalog

Phase A adds a provider-specific catalog on top of the existing generic media
source tables. `youtube_videos` stores YouTube metadata and the relationship to
the generic `media_sources` row; `youtube_video_metric_snapshots` preserves
historical counts. The existing Clip Validator candidate, render, review, and
dashboard tables are unchanged.

The archive backfill catalogs existing local MP4s without copying or
redownloading them. An archive-backed row has `ingestion_status=archive_available`
and keeps the absolute archive path so a later ingest operation can register or
copy the file into the backend AssetStore. A video already linked to a source
asset is marked `asset_registered`.

Run against the local Docker Postgres instance:

```bash
DATABASE_URL=postgres://clipper:clipper@127.0.0.1:5433/clipper pnpm db:migrate
YOUTUBE_ARCHIVE_DIR="$HOME/Movies/Axios YouTube" \
DATABASE_URL=postgres://clipper:clipper@127.0.0.1:5433/clipper \
pnpm db:backfill-youtube
```

The script is idempotent by YouTube video ID. It updates current metadata and
adds a metric snapshot on each run, but it does not create processing jobs or
change existing candidate review state.
