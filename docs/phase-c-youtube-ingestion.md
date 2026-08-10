# Phase C YouTube Ingestion Handoff

Phase C connects cataloged YouTube rows to the existing durable processing
queue. It is intentionally explicit: metadata sync does not download media by
itself, and a caller must invoke an ingest or automation-run endpoint before a
worker can download anything.

## Endpoints

```text
POST /v1/youtube/ingest
POST /v1/youtube/videos/:videoId/ingest
POST /v1/youtube/automation/run
```

The ingest body supports:

```json
{
  "channelId": "UCfU4-ArXuSX0tpyApyklMAg",
  "limit": 5,
  "mode": "find_moments",
  "dryRun": false
}
```

`mode` can be `whole_media`, `find_moments`, or `transcribe_only`. The default
is `find_moments`, which uses the worker to download the source, probe it,
transcribe it, and generate ranked clip candidates. `dryRun: true` returns the
next eligible catalog rows without creating jobs.

Only public, non-live videos with `ingestion_status=discovered` are selected
by bulk ingest. Each queued job uses an idempotency key derived from the
catalog row and mode, so retries cannot create duplicate processing jobs.

The automation endpoint runs a normal incremental YouTube metadata sync and
then queues up to the requested ingest limit. It is suitable for a daily cron,
host scheduler, or later internal scheduler. It does not perform a full scan
unless `fullScan` is explicitly true.

## Worker lifecycle

Once a job is queued, the existing worker owns the media work:

1. `queued`: catalog row is linked to a durable processing job.
2. `downloading`: the configured `yt-dlp` platform adapter fetches one video.
3. `asset_registered`: the source media is stored in the AssetStore.
4. `processing`: ffprobe, transcription, and candidate generation run.
5. `ready`: the processing job completed and candidates are available for review.
6. `failed`: the worker records the error on both the job and catalog row.

Archived files from Phase A remain separate from this automatic path. An
`archive_available` row requires an explicit archive import step because the
host archive is not mounted into the worker container.
