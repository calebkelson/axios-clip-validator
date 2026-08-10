import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

type ProviderPayload = Record<string, unknown>;

const archiveDirectory = process.env.YOUTUBE_ARCHIVE_DIR ?? '/Users/calebkelson/Movies/Axios YouTube';
const connectionString = process.env.DATABASE_URL ?? 'postgres://clipper:clipper@127.0.0.1:5433/clipper';

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const decimal = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function videoIdFromFilename(filename: string) {
  const match = filename.match(/\[([A-Za-z0-9_-]{11})\]\.mp4$/);
  return match?.[1] ?? null;
}

function publishedAtFromInfo(info: ProviderPayload) {
  const timestamp = integer(info.timestamp);
  return timestamp === null ? null : new Date(timestamp * 1000);
}

function uploadDateFromInfo(info: ProviderPayload) {
  const value = text(info.upload_date);
  return value && /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : null;
}

function normalizedPayload(info: ProviderPayload, filename: string, byteSize: number) {
  return {
    id: text(info.id),
    title: text(info.title),
    description: text(info.description),
    channel: text(info.channel),
    channelId: text(info.channel_id),
    uploader: text(info.uploader),
    uploaderId: text(info.uploader_id),
    webpageUrl: text(info.webpage_url),
    duration: decimal(info.duration),
    uploadDate: text(info.upload_date),
    timestamp: integer(info.timestamp),
    availability: text(info.availability),
    liveStatus: text(info.live_status),
    thumbnail: text(info.thumbnail),
    viewCount: integer(info.view_count),
    likeCount: integer(info.like_count),
    commentCount: integer(info.comment_count),
    archiveFilename: filename,
    archiveByteSize: byteSize,
  };
}

async function loadInfoFiles(files: string[]) {
  const infoById = new Map<string, ProviderPayload>();
  for (const filename of files.filter((file) => file.endsWith('.info.json'))) {
    try {
      const payload = JSON.parse(await readFile(join(archiveDirectory, filename), 'utf8')) as ProviderPayload;
      const id = text(payload.id);
      if (id) infoById.set(id, payload);
    } catch (error) {
      console.warn(`Skipping invalid metadata file ${filename}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  return infoById;
}

async function ensureChannel(client: pg.PoolClient, info: ProviderPayload) {
  const youtubeChannelId = text(info.channel_id) ?? 'UCfU4-ArXuSX0tpyApyklMAg';
  const result = await client.query(`
    INSERT INTO youtube_channels(youtube_channel_id,handle,name,updated_at)
    VALUES($1,$2,$3,now())
    ON CONFLICT(youtube_channel_id) DO UPDATE SET handle=COALESCE(EXCLUDED.handle,youtube_channels.handle), name=COALESCE(EXCLUDED.name,youtube_channels.name), updated_at=now()
    RETURNING id
  `, [youtubeChannelId, text(info.uploader_id), text(info.channel) ?? text(info.uploader)]);
  return result.rows[0].id as string;
}

async function findOrCreateSource(client: pg.PoolClient, videoId: string, canonicalUrl: string, info: ProviderPayload, filename: string, archivePath: string) {
  const existing = await client.query(`
    SELECT s.id, EXISTS(SELECT 1 FROM assets a WHERE a.source_id=s.id AND a.role='source') AS has_asset
    FROM media_sources s
    WHERE s.canonical_url=$1
      OR s.metadata->>'youtubeVideoId'=$2
      OR s.raw_provider_payload->>'id'=$2
      OR s.metadata->>'originalFilename' ILIKE $3
    ORDER BY (s.canonical_url=$1) DESC, has_asset DESC, s.created_at ASC
    LIMIT 1
  `, [canonicalUrl, videoId, `%[${videoId}].mp4%`]);
  const sourceMetadata = JSON.stringify({ source: 'youtube-archive-backfill', youtubeVideoId: videoId, youtubeChannelId: text(info.channel_id), originalFilename: filename, archivePath });
  const payload = JSON.stringify(normalizedPayload(info, filename, (await stat(archivePath)).size));
  if (existing.rowCount) {
    await client.query(`
      UPDATE media_sources
      SET canonical_url=COALESCE(canonical_url,$2), provider=COALESCE(provider,'youtube'), metadata=metadata || $3::jsonb, raw_provider_payload=COALESCE(raw_provider_payload,$4::jsonb)
      WHERE id=$1
    `, [existing.rows[0].id, canonicalUrl, sourceMetadata, payload]);
    return { id: existing.rows[0].id as string, hasAsset: Boolean(existing.rows[0].has_asset), created: false };
  }
  const created = await client.query(`
    INSERT INTO media_sources(source_type,media_type,uri,canonical_url,provider,metadata,raw_provider_payload)
    VALUES('platform_url','video',$1,$1,'youtube',$2::jsonb,$3::jsonb)
    RETURNING id
  `, [canonicalUrl, sourceMetadata, payload]);
  return { id: created.rows[0].id as string, hasAsset: false, created: true };
}

async function main() {
  const files = await readdir(archiveDirectory);
  const mp4Files = files.filter((file) => file.endsWith('.mp4')).sort();
  const infoById = await loadInfoFiles(files);
  const client = new pg.Pool({ connectionString });
  const db = await client.connect();
  let inserted = 0;
  let updated = 0;
  let sourcesCreated = 0;
  let snapshots = 0;
  try {
    await db.query('BEGIN');
    for (const filename of mp4Files) {
      const videoId = videoIdFromFilename(filename);
      if (!videoId) {
        console.warn(`Skipping MP4 without a YouTube ID: ${filename}`);
        continue;
      }
      const archivePath = join(archiveDirectory, filename);
      const info = infoById.get(videoId) ?? {};
      const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const byteSize = (await stat(archivePath)).size;
      const channelId = await ensureChannel(db, info);
      const source = await findOrCreateSource(db, videoId, canonicalUrl, info, filename, archivePath);
      if (source.created) sourcesCreated++;
      const ingestionStatus = source.hasAsset ? 'asset_registered' : 'archive_available';
      const payload = normalizedPayload(info, filename, byteSize);
      const result = await db.query(`
        INSERT INTO youtube_videos(
          youtube_video_id,channel_id,media_source_id,canonical_url,title,description,channel_name,uploader_id,
          published_at,upload_date,duration_seconds,availability,live_status,thumbnail_url,view_count,like_count,comment_count,
          archive_path,archive_filename,archive_byte_size,ingestion_status,last_seen_at,last_metadata_sync_at,raw_provider_payload,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,now(),now(),$22::jsonb,now())
        ON CONFLICT(youtube_video_id) DO UPDATE SET
          channel_id=EXCLUDED.channel_id, media_source_id=COALESCE(youtube_videos.media_source_id,EXCLUDED.media_source_id), canonical_url=EXCLUDED.canonical_url,
          title=EXCLUDED.title, description=EXCLUDED.description, channel_name=EXCLUDED.channel_name, uploader_id=EXCLUDED.uploader_id,
          published_at=EXCLUDED.published_at, upload_date=EXCLUDED.upload_date, duration_seconds=EXCLUDED.duration_seconds,
          availability=EXCLUDED.availability, live_status=EXCLUDED.live_status, thumbnail_url=EXCLUDED.thumbnail_url,
          view_count=EXCLUDED.view_count, like_count=EXCLUDED.like_count, comment_count=EXCLUDED.comment_count,
          archive_path=EXCLUDED.archive_path, archive_filename=EXCLUDED.archive_filename, archive_byte_size=EXCLUDED.archive_byte_size,
          ingestion_status=CASE WHEN youtube_videos.ingestion_status IN ('queued','downloading','asset_registered','processing','ready') THEN youtube_videos.ingestion_status ELSE EXCLUDED.ingestion_status END,
          last_seen_at=now(), last_metadata_sync_at=now(), raw_provider_payload=EXCLUDED.raw_provider_payload, updated_at=now()
        RETURNING id, (xmax = 0) AS inserted
      `, [
        videoId, channelId, source.id, canonicalUrl,
        text(info.title) ?? filename.replace(/\.mp4$/, ''), text(info.description), text(info.channel) ?? text(info.uploader), text(info.uploader_id),
        publishedAtFromInfo(info), uploadDateFromInfo(info), decimal(info.duration), text(info.availability), text(info.live_status), text(info.thumbnail),
        integer(info.view_count), integer(info.like_count), integer(info.comment_count), archivePath, filename, byteSize, ingestionStatus, JSON.stringify(payload),
      ]);
      if (result.rows[0].inserted) inserted++; else updated++;
      const videoDbId = result.rows[0].id as string;
      const currentMetrics = [integer(info.view_count), integer(info.like_count), integer(info.comment_count)];
      const latestMetric = await db.query('SELECT view_count,like_count,comment_count FROM youtube_video_metric_snapshots WHERE video_id=$1 ORDER BY observed_at DESC LIMIT 1', [videoDbId]);
      const metricsChanged = !latestMetric.rowCount || currentMetrics.some((value, index) => {
        const latest = latestMetric.rows[0][['view_count', 'like_count', 'comment_count'][index]];
        return (latest === null ? null : Number(latest)) !== value;
      });
      if (metricsChanged) {
        await db.query(`
          INSERT INTO youtube_video_metric_snapshots(video_id,view_count,like_count,comment_count,raw_provider_payload)
          VALUES($1,$2,$3,$4,$5::jsonb)
        `, [videoDbId, currentMetrics[0], currentMetrics[1], currentMetrics[2], JSON.stringify({ viewCount: currentMetrics[0], likeCount: currentMetrics[1], commentCount: currentMetrics[2], source: 'yt-dlp-info-json' })]);
        snapshots++;
      }
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
    await client.end();
  }
  console.log(JSON.stringify({ archiveDirectory, mp4Files: mp4Files.length, matchedInfo: [...infoById.keys()].filter((id) => mp4Files.some((file) => file.includes(`[${id}]`))).length, inserted, updated, sourcesCreated, snapshots }, null, 2));
}

await main();
