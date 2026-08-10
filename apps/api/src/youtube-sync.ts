import pg from 'pg';

type FetchLike = typeof fetch;

export type YouTubeChannelResource = {
  id: string;
  snippet: { title?: string; customUrl?: string };
  contentDetails: { relatedPlaylists?: { uploads?: string } };
};

export type YouTubePlaylistItem = {
  snippet?: { publishedAt?: string; title?: string; channelTitle?: string };
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
};

export type YouTubeVideoResource = {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    channelId?: string;
    channelTitle?: string;
    publishedAt?: string;
    liveBroadcastContent?: string;
    thumbnails?: Record<string, { url?: string }>;
  };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  status?: { privacyStatus?: string; uploadStatus?: string; embeddable?: boolean };
};

export type YouTubeSyncResult = {
  channelId: string;
  uploadsPlaylistId: string;
  fullScan: boolean;
  pagesScanned: number;
  videosSeen: number;
  videosUpserted: number;
  newVideos: number;
  metricSnapshots: number;
  stoppedAtSyncCursor: boolean;
  lastSeenPublishedAt: string | null;
};

export class YouTubeSyncError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 502) {
    super(message);
    this.name = 'YouTubeSyncError';
  }
}

export class YouTubeSyncLockedError extends YouTubeSyncError {
  constructor() {
    super('youtube_sync_in_progress', 'A sync is already running for this channel.', 409);
  }
}

export class YouTubeDataApiClient {
  private readonly requestFetch: FetchLike;

  constructor(private readonly apiKey: string, requestFetch: FetchLike = fetch) {
    this.requestFetch = requestFetch;
  }

  async getChannel(channelId: string) {
    const response = await this.request<{ items?: YouTubeChannelResource[] }>('channels', {
      part: 'snippet,contentDetails',
      id: channelId,
    });
    const channel = response.items?.[0];
    if (!channel) throw new YouTubeSyncError('youtube_channel_not_found', `YouTube channel ${channelId} was not found.`, 404);
    return channel;
  }

  async listUploads(uploadsPlaylistId: string, pageToken?: string) {
    return this.request<{ nextPageToken?: string; items?: YouTubePlaylistItem[] }>('playlistItems', {
      part: 'snippet,contentDetails,status',
      playlistId: uploadsPlaylistId,
      maxResults: '50',
      ...(pageToken ? { pageToken } : {}),
    });
  }

  async getVideos(videoIds: string[]) {
    if (!videoIds.length) return [];
    const response = await this.request<{ items?: YouTubeVideoResource[] }>('videos', {
      part: 'snippet,contentDetails,statistics,status',
      id: videoIds.join(','),
    });
    return response.items ?? [];
  }

  private async request<T>(resource: string, params: Record<string, string>) {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    url.searchParams.set('key', this.apiKey);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.requestFetch(url, { headers: { accept: 'application/json' } });
    const body = await response.json() as T & { error?: { message?: string; errors?: Array<{ reason?: string }> } };
    if (!response.ok) {
      const reason = body.error?.errors?.[0]?.reason;
      throw new YouTubeSyncError('youtube_api_error', body.error?.message ?? `YouTube API request failed (${response.status})${reason ? `: ${reason}` : ''}`, 502);
    }
    return body;
  }
}

type SyncChannelRow = {
  id: string;
  youtube_channel_id: string;
  handle: string | null;
  name: string | null;
  uploads_playlist_id: string | null;
  last_synced_published_at: Date | null;
};

type Queryable = pg.Pool | pg.PoolClient;

const safeCount = (value: unknown) => typeof value === 'string' && /^\d+$/.test(value) ? value : null;
const safeDate = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value) : null;

export function parseDurationSeconds(value: string | undefined) {
  if (!value?.startsWith('PT')) return null;
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function thumbnailUrl(video: YouTubeVideoResource) {
  const thumbnails = video.snippet?.thumbnails ?? {};
  for (const key of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const url = thumbnails[key]?.url;
    if (url) return url;
  }
  return null;
}

function sourceMetadata(video: YouTubeVideoResource, channel: SyncChannelRow) {
  return {
    source: 'youtube-data-api',
    youtubeVideoId: video.id,
    youtubeChannelId: channel.youtube_channel_id,
    title: video.snippet?.title ?? video.id,
    channelName: video.snippet?.channelTitle ?? channel.name,
    publishedAt: video.snippet?.publishedAt ?? null,
  };
}

async function ensureSource(db: Queryable, video: YouTubeVideoResource, channel: SyncChannelRow) {
  const canonicalUrl = `https://www.youtube.com/watch?v=${video.id}`;
  const metadata = JSON.stringify(sourceMetadata(video, channel));
  const existing = await db.query(`
    SELECT s.id, EXISTS(SELECT 1 FROM assets a WHERE a.source_id=s.id AND a.role='source') AS has_asset
    FROM media_sources s
    WHERE s.canonical_url=$1 OR s.metadata->>'youtubeVideoId'=$2 OR s.raw_provider_payload->>'id'=$2
    ORDER BY (s.canonical_url=$1) DESC, has_asset DESC, s.created_at ASC
    LIMIT 1
  `, [canonicalUrl, video.id]);
  if (existing.rowCount) {
    await db.query("UPDATE media_sources SET canonical_url=COALESCE(canonical_url,$2), provider=COALESCE(provider,'youtube'), metadata=metadata || $3::jsonb WHERE id=$1", [existing.rows[0].id, canonicalUrl, metadata]);
    return { id: existing.rows[0].id as string, hasAsset: Boolean(existing.rows[0].has_asset), created: false };
  }
  const created = await db.query(`
    INSERT INTO media_sources(source_type,media_type,uri,canonical_url,provider,metadata)
    VALUES('platform_url','video',$1,$1,'youtube',$2::jsonb)
    RETURNING id
  `, [canonicalUrl, metadata]);
  return { id: created.rows[0].id as string, hasAsset: false, created: true };
}

async function upsertVideo(db: Queryable, video: YouTubeVideoResource, channel: SyncChannelRow) {
  const source = await ensureSource(db, video, channel);
  const publishedAt = safeDate(video.snippet?.publishedAt);
  const payload = JSON.stringify({
    id: video.id,
    title: video.snippet?.title ?? null,
    description: video.snippet?.description ?? null,
    channelId: video.snippet?.channelId ?? channel.youtube_channel_id,
    channelTitle: video.snippet?.channelTitle ?? channel.name,
    publishedAt: video.snippet?.publishedAt ?? null,
    duration: video.contentDetails?.duration ?? null,
    statistics: video.statistics ?? {},
    status: video.status ?? {},
  });
  const initialStatus = source.hasAsset ? 'asset_registered' : 'discovered';
  const result = await db.query(`
    INSERT INTO youtube_videos(
      youtube_video_id,channel_id,media_source_id,canonical_url,title,description,channel_name,uploader_id,published_at,
      duration_seconds,availability,live_status,thumbnail_url,view_count,like_count,comment_count,ingestion_status,
      first_seen_at,last_seen_at,last_metadata_sync_at,raw_provider_payload,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),now(),now(),$18::jsonb,now())
    ON CONFLICT(youtube_video_id) DO UPDATE SET
      channel_id=EXCLUDED.channel_id, media_source_id=COALESCE(youtube_videos.media_source_id,EXCLUDED.media_source_id), canonical_url=EXCLUDED.canonical_url,
      title=EXCLUDED.title, description=EXCLUDED.description, channel_name=EXCLUDED.channel_name, uploader_id=EXCLUDED.uploader_id,
      published_at=COALESCE(EXCLUDED.published_at,youtube_videos.published_at), duration_seconds=EXCLUDED.duration_seconds,
      availability=EXCLUDED.availability, live_status=EXCLUDED.live_status, thumbnail_url=EXCLUDED.thumbnail_url,
      view_count=EXCLUDED.view_count, like_count=EXCLUDED.like_count, comment_count=EXCLUDED.comment_count,
      ingestion_status=CASE WHEN youtube_videos.ingestion_status='discovered' AND $19=true THEN 'asset_registered' ELSE youtube_videos.ingestion_status END,
      last_seen_at=now(), last_metadata_sync_at=now(), raw_provider_payload=EXCLUDED.raw_provider_payload, updated_at=now()
    RETURNING id, (xmax = 0) AS inserted
  `, [
    video.id, channel.id, source.id, `https://www.youtube.com/watch?v=${video.id}`, video.snippet?.title ?? video.id,
    video.snippet?.description ?? null, video.snippet?.channelTitle ?? channel.name, video.snippet?.channelId ?? channel.youtube_channel_id,
    publishedAt, parseDurationSeconds(video.contentDetails?.duration), video.status?.privacyStatus ?? null,
    video.snippet?.liveBroadcastContent ?? null, thumbnailUrl(video), safeCount(video.statistics?.viewCount), safeCount(video.statistics?.likeCount),
    safeCount(video.statistics?.commentCount), initialStatus, payload, source.hasAsset,
  ]);
  const videoDbId = result.rows[0].id as string;
  const metrics = [safeCount(video.statistics?.viewCount), safeCount(video.statistics?.likeCount), safeCount(video.statistics?.commentCount)];
  const latest = await db.query('SELECT view_count,like_count,comment_count FROM youtube_video_metric_snapshots WHERE video_id=$1 ORDER BY observed_at DESC LIMIT 1', [videoDbId]);
  const metricsChanged = !latest.rowCount || metrics.some((value, index) => {
    const latestValue = latest.rows[0][['view_count', 'like_count', 'comment_count'][index]];
    return (latestValue === null ? null : String(latestValue)) !== value;
  });
  if (metricsChanged) {
    await db.query('INSERT INTO youtube_video_metric_snapshots(video_id,view_count,like_count,comment_count,raw_provider_payload) VALUES($1,$2,$3,$4,$5::jsonb)', [videoDbId, metrics[0], metrics[1], metrics[2], JSON.stringify({ source: 'youtube-data-api', statistics: video.statistics ?? {} })]);
  }
  return { inserted: Boolean(result.rows[0].inserted), metricsChanged, publishedAt };
}

export class YouTubeCatalogSync {
  constructor(private readonly db: pg.Pool, private readonly api: YouTubeDataApiClient, private readonly defaultMaxPages = 100) {}

  async syncChannel(identifier: string, options: { fullScan?: boolean; maxPages?: number } = {}): Promise<YouTubeSyncResult> {
    const maxPages = options.maxPages ?? this.defaultMaxPages;
    const locked = await this.db.query<SyncChannelRow>(`UPDATE youtube_channels SET sync_status='running',sync_started_at=now(),last_error=NULL,updated_at=now() WHERE (id::text=$1 OR youtube_channel_id=$1) AND (sync_status <> 'running' OR sync_started_at IS NULL OR sync_started_at < now() - interval '30 minutes') RETURNING *`, [identifier]);
    if (!locked.rowCount) {
      const exists = await this.db.query('SELECT sync_status FROM youtube_channels WHERE id::text=$1 OR youtube_channel_id=$1', [identifier]);
      if (!exists.rowCount) throw new YouTubeSyncError('youtube_channel_not_found', `Catalog channel ${identifier} was not found.`, 404);
      throw new YouTubeSyncLockedError();
    }
    const channel = locked.rows[0];
    let pagesScanned = 0;
    let videosSeen = 0;
    let videosUpserted = 0;
    let newVideos = 0;
    let metricSnapshots = 0;
    let stoppedAtSyncCursor = false;
    let lastSeenPublishedAt = channel.last_synced_published_at;
    try {
      const apiChannel = await this.api.getChannel(channel.youtube_channel_id);
      const uploadsPlaylistId = apiChannel.contentDetails.relatedPlaylists?.uploads;
      if (!uploadsPlaylistId) throw new YouTubeSyncError('youtube_uploads_playlist_missing', `No uploads playlist was returned for ${channel.youtube_channel_id}.`, 502);
      await this.db.query('UPDATE youtube_channels SET uploads_playlist_id=$2,handle=COALESCE($3,handle),name=COALESCE($4,name),updated_at=now() WHERE id=$1', [channel.id, uploadsPlaylistId, apiChannel.snippet?.customUrl ?? null, apiChannel.snippet?.title ?? null]);
      let cursor: string | null = channel.last_synced_published_at?.toISOString() ?? null;
      if (!cursor) {
        const previous = await this.db.query<{ max_published_at: Date | null }>('SELECT MAX(published_at) AS max_published_at FROM youtube_videos WHERE channel_id=$1', [channel.id]);
        cursor = previous.rows[0]?.max_published_at?.toISOString?.() ?? null;
      }
      let pageToken: string | undefined;
      while (pagesScanned < maxPages) {
        const page = await this.api.listUploads(uploadsPlaylistId, pageToken);
        pagesScanned++;
        const items = page.items ?? [];
        videosSeen += items.length;
        const ids = items.map((item) => item.contentDetails?.videoId).filter((id): id is string => Boolean(id));
        const videos = await this.api.getVideos(ids);
        for (const video of videos) {
          const result = await upsertVideo(this.db, video, { ...channel, uploads_playlist_id: uploadsPlaylistId });
          videosUpserted++;
          if (result.inserted) newVideos++;
          if (result.metricsChanged) metricSnapshots++;
          if (result.publishedAt && (!lastSeenPublishedAt || result.publishedAt > lastSeenPublishedAt)) lastSeenPublishedAt = result.publishedAt;
        }
        const publishedDates = items.map((item) => safeDate(item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt)).filter((date): date is Date => Boolean(date));
        const pageIsAtOrBeforeCursor = Boolean(cursor && publishedDates.length && publishedDates.every((date) => date <= new Date(cursor)));
        if (!options.fullScan && pageIsAtOrBeforeCursor) {
          stoppedAtSyncCursor = true;
          break;
        }
        pageToken = page.nextPageToken;
        if (!pageToken) break;
      }
      const summary = { channelId: channel.youtube_channel_id, uploadsPlaylistId, fullScan: options.fullScan ?? false, pagesScanned, videosSeen, videosUpserted, newVideos, metricSnapshots, stoppedAtSyncCursor, lastSeenPublishedAt: lastSeenPublishedAt?.toISOString() ?? null };
      await this.db.query("UPDATE youtube_channels SET uploads_playlist_id=$2,sync_status='completed',sync_started_at=NULL,last_synced_at=now(),last_synced_published_at=COALESCE($3,last_synced_published_at),last_sync_summary=$4::jsonb,updated_at=now() WHERE id=$1", [channel.id, uploadsPlaylistId, lastSeenPublishedAt, JSON.stringify(summary)]);
      return summary;
    } catch (error) {
      await this.db.query("UPDATE youtube_channels SET sync_status='failed',sync_started_at=NULL,last_error=$2,updated_at=now() WHERE id=$1", [channel.id, error instanceof Error ? error.message.slice(0, 4000) : 'YouTube sync failed']);
      throw error;
    }
  }
}
