# Phase 4 FFmpeg Rendering Contract

Phase 4 turns a reviewed clip candidate into a producer-ready render package. It intentionally uses FFmpeg and ordinary sidecar files rather than Remotion. PostgreSQL owns render state; the worker owns media processing; the `AssetStore` owns bytes.

## Flow

```text
clip_candidates + transcript_segments
                |
                v
       clip_renders(status=queued)
                |
                v
    FFmpeg worker: crop, logo, captions, audio
                |
                v
  MP4 + thumbnail + SRT + render-manifest.json
```

## API

Create a render:

```http
POST /v1/candidates/:candidateId/renders
Content-Type: application/json
```

```json
{
  "profile": "vertical_reel",
  "captionMode": "burned",
  "includeLogo": true
}
```

Supported profiles:

| Profile | Output | Axios layout used |
| --- | --- | --- |
| `vertical_reel` | 1080x1920 | 64px horizontal margin, 280px top and bottom safe areas, 64px logo height |
| `square` | 1080x1080 | 64px margin and 64px logo height |
| `landscape` | 1920x1080 | 96px margin and 96px logo height |

`captionMode` is `none`, `sidecar`, or `burned`. `sidecar` produces an SRT without putting captions in the MP4. `burned` uses an ASS intermediate file to place captions in the lower safe area. The generated SRT is retained for producer review even when captions are burned.

Poll `GET /v1/renders/:renderId`. Completed renders expose URLs for the MP4, thumbnail, SRT, and manifest. The bytes are available through `GET /v1/assets/:assetId`.

## Brand decisions from the supplied guidelines

- NB International Pro is the intended typeface. The supplied `NBInternationalPro-Bold.ttf` is bundled and configured as `NB International Pro Bold`; the worker retains DejaVu Sans only as a fallback.
- Sentence case is used for caption text. The renderer avoids all-caps paragraphs, rotation, gradients, transparency overlays, and arbitrary colors.
- The approved Axios logo is copied to `assets/brand/axios-logo.png` and placed inside the profile safe area.
- The renderer uses full-bleed crop-to-fill framing. It burns timed headline cards over the video using the selected color and the configured Axios font; the cards are not a split layout.
- `socialCopy.headlineCards` stores the editable card text, color, and clip-relative start/end times. The renderer also writes those cards to `render-manifest.json` for producer handoff.
- `socialCopy.caption` and `socialCopy.hashtags` stay outside the MP4 as publishing metadata.
- The manifest records the source, candidate timestamps, selected profile, caption mode, branding configuration, and social copy so a producer can revise the trim or rebuild with another renderer later.

## Font configuration

The current Docker worker uses the supplied font with:

```text
BRAND_FONT_PATH=/app/assets/brand/NBInternationalPro-Bold.ttf
BRAND_FONT_NAME=NB International Pro Bold
```

The renderer passes the containing font directory to FFmpeg's subtitles filter and fails the render early if a configured font file is missing. Replace those values only when the corresponding licensed Axios font style is available.

## Output layout

Local output is stored under:

```text
data/renders/<renderId>/clip.mp4
data/renders/<renderId>/thumbnail.jpg
data/renders/<renderId>/captions.srt
data/renders/<renderId>/render-manifest.json
```

The database stores each file as an asset and stores the manifest JSON on `clip_renders` for quick status responses. The durable render lease is renewed while FFmpeg is running, so a worker restart can requeue an expired render without leaving it permanently stuck in `processing`.
