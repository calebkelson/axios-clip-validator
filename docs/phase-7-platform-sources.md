# Phase 7 Platform Sources

Phase 7 adds a provider-neutral platform download boundary. Uploaded files and
direct media URLs continue through the existing local asset path. A
`platform_url` source can use the optional `yt-dlp` adapter, which downloads a
single source into the worker's temporary directory, checks the configured
maximum size, and stores the resulting media in the same canonical source asset
table used by uploads and direct URLs.

## Configuration

Set these worker environment variables:

- `SOURCE_PLATFORM_ADAPTER=yt-dlp`
- `YTDLP_BIN=/opt/yt-dlp/bin/yt-dlp`
- `SOURCE_PLATFORM_PROVIDERS=youtube,vimeo,tiktok,instagram,x,facebook,linkedin`

The Docker worker image installs yt-dlp in an isolated Python virtual
environment. The provider list is an allowlist; a URL is not downloaded just
because a caller supplied an arbitrary provider string.

## API shape

Create a source with:

```json
{
  "sourceType": "platform_url",
  "mediaType": "video",
  "provider": "vimeo",
  "uri": "https://vimeo.com/example"
}
```

Queueing the normal `find_moments` job then runs platform download, ffprobe,
transcription, candidate generation, and render preparation through the same
durable job state machine. The downloaded asset records the adapter and
provider in `assets.metadata` for auditability.

The adapter is intentionally separate from the API and candidate logic so a
future authenticated provider or first-party API integration can replace
yt-dlp without changing the source, job, transcript, or render contracts.
