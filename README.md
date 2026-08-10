# Axios clipping platform — Phase 4

Provider-neutral backend for media sources, durable processing jobs, local ingestion, media probing, transcripts, ranked clip candidates, producer review metadata, and FFmpeg rendering. It has no runtime dependency on n8n, Opus Clip, Supabase, or Remotion, and does not modify the separate Clip Validator frontend.

## Local setup

Use Node 22 and pnpm. Copy `.env.example` to `.env`, run `pnpm install`, then `docker compose up -d postgres` and `pnpm db:migrate`. Start API and worker separately with `pnpm --filter @clipper/api dev` and `pnpm --filter @clipper/worker dev`.

Or run the complete local stack: `docker compose up --build`. Apply migrations from the host after PostgreSQL is healthy: `DATABASE_URL=postgres://clipper:clipper@localhost:5433/clipper pnpm db:migrate`.

Environment: `DATABASE_URL`, `PORT` (3000), `ASSET_DATA_DIR` (shared local assets), `MAX_UPLOAD_BYTES` (defaults to 5 GB), `MAX_SOURCE_BYTES` (defaults to 5 GB), `WORKER_CONCURRENCY` (currently 1), `LEASE_SECONDS` (defaults to 60), `RENDER_LEASE_SECONDS` (defaults to `LEASE_SECONDS`), `FFMPEG_BIN`, `FFMPEG_PRESET` (`veryfast`), `FFMPEG_CRF` (`20`), `BRAND_LOGO_PATH`, optional `BRAND_FONT_PATH`, optional `BRAND_FONT_NAME`, `FFPROBE_BIN` (defaults to `ffprobe`), `TRANSCRIPTION_PROVIDER` (`sidecar` by default or `whisper`), `WHISPER_BIN`, `WHISPER_MODEL`, `WHISPER_LANGUAGE`, `CANDIDATE_MIN_SECONDS` (8), `CANDIDATE_MAX_SECONDS` (90), `MAX_CANDIDATES` (8), `YOUTUBE_DATA_API_KEY`, `YOUTUBE_CHANNEL_ID`, and `YOUTUBE_SYNC_MAX_PAGES` (100).

## API examples

`POST /v1/sources` body: `{"sourceType":"direct_url","mediaType":"video","uri":"https://media.example/video.mp4"}`.

`POST /v1/uploads` accepts a streamed `multipart/form-data` file. Set `X-Media-Type: video` or `audio`; it returns a source and its canonical local asset. `GET /v1/sources/:sourceId` returns source assets and probe state.

`POST /v1/jobs` body: `{"sourceId":"<uuid>","mode":"find_moments","idempotencyKey":"client-retry-key"}`. The same key returns the existing durable job. `whole_media` ingests and probes; `transcribe_only` also persists transcript segments; `find_moments` generates ranked candidates after transcription. Read transcript state at `GET /v1/jobs/:jobId/transcript` and candidates at `GET /v1/jobs/:jobId/candidates`. Producers can update a candidate with `PATCH /v1/candidates/:candidateId` using timestamps, `reviewStatus`, `reviewer`, `notes`, or a complete `socialCopy` block.

Queue an FFmpeg render with `POST /v1/candidates/:candidateId/renders` and body `{"profile":"vertical_reel","captionMode":"burned","includeLogo":true}`. Profiles are `vertical_reel` (1080x1920), `square` (1080x1080), and `landscape` (1920x1080). Caption modes are `none`, `sidecar`, and `burned`. Poll `GET /v1/renders/:renderId`; a completed render exposes playback, thumbnail, captions, and manifest URLs. Serve an asset with `GET /v1/assets/:assetId`.

## Worker behavior

PostgreSQL is the queue and source of truth. The worker uses `FOR UPDATE SKIP LOCKED`, leases a job, increments attempts, requeues expired leases, streams direct sources into canonical assets, runs `ffprobe`, persists probe metadata, generates transcript-grounded candidates, and renders queued clips. Worker containers include `ffmpeg`, `ffprobe`, the approved Axios logo, the supplied NB International Pro Bold font, a DejaVu fallback, a writable temp directory, and the mounted `./data` directory. Storage is behind `AssetStore`; the local implementation returns `local://` references and has no paths embedded in domain models. An S3/R2 store can later implement that interface.

Each candidate includes timestamped transcript evidence, score, confidence, rationale, and a social-copy object: `{ "headline": "...", "caption": "...", "hashtags": ["#Axios"], "headlineCards": [{ "id": "headline-1", "text": "...", "startSeconds": 0, "endSeconds": 3, "color": "navy" }] }`. Social copy is generated from that candidate's own transcript window, so overlapping clips do not inherit one video-wide caption or hashtag set. Headline cards are clip-relative, timed overlays that are sent to FFmpeg; the post caption and hashtags remain publishing metadata.

Only `find_moments` jobs use the candidate provider. Find Moments first searches the full video transcript for coherent utterance boundaries and hook-to-payoff windows, using a hard 30–60 second range. The selector deliberately keeps short, mid-length, and long variants in the candidate pool so a source does not produce a queue of near-identical 30-second cuts. It then applies the existing `weighted-moment-v2` score to each proposed clip transcript, normalized to `0..1` and stored in `clip_candidates.score`. Its weighted dimensions are hook strength (18), payoff strength (16), standalone clarity (14), audience value (14), emotion and tension (10), shareability and quotability (10), specificity and credibility (7), novelty (6), and density and momentum (5). The normalized per-dimension values are retained in `clip_candidates.metadata.scoreDimensions` for review and future model-backed scoring. Each candidate's transcript is passed to the transcript editorial copy agent, which writes fresh clip-specific headline, caption, and five-hashtag metadata rather than copying a transcript sentence or using one video-wide caption. `whole_media` and `transcribe_only` jobs do not generate candidate scores, headlines, captions, or hashtags.

The default `sidecar` transcription provider is deterministic and local: place `<asset>.transcript.json` beside the media file in the shared asset store with `{ "language": "en", "segments": [{ "start": 0, "end": 2, "text": "..." }] }`. Set `TRANSCRIPTION_PROVIDER=whisper` when the `whisper` CLI and model are installed in the worker environment; its JSON output is normalized into the same transcript tables. `CANDIDATE_MIN_SECONDS` and `CANDIDATE_MAX_SECONDS` are clamped to the product's 30–60 second Find Moments range.

Phase 4 uses the supplied Axios brand guidelines to keep logo placement, safe margins, social dimensions, no-gradient color handling, headline-card overlays, and caption composition in one FFmpeg renderer. Headline cards are written to the render manifest and burned into the MP4 with their selected color and clip-relative timing. The post caption and hashtags remain metadata. The supplied `NBInternationalPro-Bold.ttf` is bundled and configured as `NB International Pro Bold`; `BRAND_FONT_PATH` and `BRAND_FONT_NAME` remain configurable for other licensed styles.

## Verification

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm db:validate`, and `docker compose config`. For a live check: `curl http://localhost:3000/healthz`; create a source and job, then query the job until it is `completed`. To verify rendering, create a render for a candidate, poll it until `completed`, and run `ffprobe` against the resulting `data/renders/<renderId>/clip.mp4`.

## Phase 6 foundation

Show-specific logo assets are durable backend records in `brand_assets` and
their files use the existing `AssetStore` boundary. Use `GET /v1/brand-assets`
to list active assets and `POST /v1/brand-assets` with an image multipart file,
`X-Brand-Show`, and optional `X-Brand-Name` headers to create one. Render
requests accept `logoAssetId`; the worker resolves the selected asset before
FFmpeg runs and records the asset ID and source type in the editable manifest.
When no asset ID is supplied, the configured default Axios logo is used.

## Phase 7 platform sources

Platform URLs now have an opt-in `yt-dlp` source adapter. Set
`SOURCE_PLATFORM_ADAPTER=yt-dlp` and configure `SOURCE_PLATFORM_PROVIDERS` to
an allowlist of supported providers. The worker downloads one media file into
temporary storage, enforces `MAX_SOURCE_BYTES`, persists it through the same
`AssetStore` path as uploads and direct URLs, and records the adapter/provider
in asset metadata. See [phase 7 platform sources](docs/phase-7-platform-sources.md).

## YouTube catalog sync

Phase 8 adds metadata-only YouTube channel sync. Set `YOUTUBE_DATA_API_KEY` on
the API service, then call `POST /v1/youtube/channels/:channelId/sync` or
`POST /v1/youtube/sync` with `{ "fullScan": false }`. The sync reads the
channel uploads playlist, fetches video metadata and current statistics, and
upserts catalog rows by YouTube video ID. It does not create processing jobs or
download media. Use `fullScan: true` for an explicit historical refresh.

`GET /v1/youtube/channels` reports sync status and `GET /v1/youtube/videos`
lists the catalog. A stale running lock is recoverable after 30 minutes, and a
failed sync records its error on the channel row for the future dashboard.

## YouTube ingestion handoff

Phase C connects discovered catalog rows to the existing worker queue. Use
`POST /v1/youtube/ingest` with `{"limit":5,"mode":"find_moments"}` to queue
new public videos, or set `dryRun` to `true` to inspect the next rows without
creating jobs. `POST /v1/youtube/automation/run` performs an incremental sync
and then queues the requested number of new videos. The worker downloads through
the configured `yt-dlp` adapter, probes, transcribes, and generates candidates;
the existing Clip Validator dashboard remains the review surface. See
[phase C YouTube ingestion](docs/phase-c-youtube-ingestion.md).

## Phase 4 limitations and next steps

The default candidate provider is a deterministic transcript-grounded editorial baseline, behind the `EditorialCandidateProvider` interface. A model-backed provider can replace it without changing the candidate or review APIs. Platform URLs are still rejected until a provider adapter is configured. Phase 4 is a local FFmpeg renderer with filesystem assets and a JSON manifest. Future phases should add object storage, platform adapters, a producer editing surface, stronger transcript/quality models, and export adapters for Premiere or other NLEs.

See [legacy mapping](docs/legacy-schema-mapping.md).
