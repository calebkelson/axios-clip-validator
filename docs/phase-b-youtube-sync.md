# Phase B YouTube Sync

Phase B adds a server-side, metadata-only channel sync. The API uses the
channel's stable YouTube channel ID to resolve its uploads playlist, pages
through `playlistItems.list`, batches video IDs into `videos.list` requests,
and upserts the results by `youtube_video_id`.

## Endpoints

```text
GET  /v1/youtube/channels
POST /v1/youtube/channels/:channelId/sync
POST /v1/youtube/sync
GET  /v1/youtube/videos
GET  /v1/youtube/videos/:videoId
```

`POST /v1/youtube/sync` uses `YOUTUBE_CHANNEL_ID` when `channelId` is omitted.
The request body supports `fullScan` and `maxPages`. Normal syncs stop after
the uploads playlist reaches the last published timestamp already seen for the
channel. A full scan walks every available page up to `maxPages`.

The sync updates metadata and metric snapshots only. It creates a generic
platform source for newly discovered videos, but it does not create a
processing job or download a video. That boundary prevents a daily catalog
refresh from unexpectedly adding work to the Clip Validator queue.

The API key is read only from `YOUTUBE_DATA_API_KEY` on the server. It is never
stored in Postgres or returned by an endpoint. Channel locks recover after 30
minutes, and failed requests persist an error on `youtube_channels`.
