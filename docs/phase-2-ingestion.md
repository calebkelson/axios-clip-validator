# Phase 2 Ingestion Contract

## Data flow

```text
upload or direct URL
        |
        v
media_sources -> assets(role=source) -> source_probes
                                      |
                         transcribe_only/find_moments
                                      v
                         transcripts -> transcript_segments
```

The API writes uploaded bytes to the shared `AssetStore`. The worker owns network downloads and media inspection. PostgreSQL records state and metadata; the filesystem is only a Phase 2 local storage implementation.

## Uploads

`POST /v1/uploads` accepts one multipart file. The API streams the file to `uploads/<sourceId>/<filename>` and creates the `media_sources` and `assets` records. The API and worker must mount the same `ASSET_DATA_DIR`.

## Direct URLs

Direct URLs are downloaded once per source into `sources/<sourceId>/original`. A content-length guard and streaming byte limit protect the worker from unexpectedly large responses. The stored asset is then passed to `ffprobe`.

Platform URLs are not treated as direct media URLs. A future adapter must resolve a platform URL into a downloadable asset and preserve provider metadata in `media_sources`.

## Probe records

`source_probes` stores the normalized duration, byte size, dimensions, codecs, frame rate, raw `ffprobe` JSON, and the last error. Probe failures fail the processing job and remain queryable through `GET /v1/sources/:sourceId`.

## Transcript providers

`TranscriptionProvider` is the worker boundary. The sidecar provider is intended for deterministic local development and tests. The Whisper CLI provider is optional and uses the same normalized segment shape, so a hosted ASR adapter can be added without changing API or database contracts.
