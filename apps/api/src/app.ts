import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { AudienceMomentSchema, AudienceSignalSchema, BrandAssetSchema, CandidateSchema, CreateJobSchema, CreateRenderSchema, CreateSourceSchema, JobSchema, ProbeSchema, RenderSchema, ThumbnailCreateSchema, ThumbnailJobSchema, ThumbnailProjectSchema, TranscriptSchema, UpdateCandidateSchema, YouTubeChannelSchema, YouTubeIngestRequestSchema, YouTubeSyncRequestSchema, YouTubeVideoSchema } from '@clipper/contracts';
import { AssetStore, type MultipartAssetStore } from '@clipper/storage';
import { z, ZodError } from 'zod';
import { YouTubeCatalogSync, YouTubeDataApiClient, YouTubeSyncError } from './youtube-sync.js';
import { YouTubeIngestionService } from './youtube-ingestion.js';

const toJob = (row: Record<string, any>) => JobSchema.parse({
  id: row.id,
  sourceId: row.source_id,
  mode: row.mode,
  status: row.status,
  attempts: row.attempts,
  progress: row.progress,
  result: row.result,
  claimedAt: row.claimed_at?.toISOString?.() ?? null,
  leaseExpiresAt: row.lease_expires_at?.toISOString?.() ?? null,
  lastError: row.last_error,
  completedAt: row.completed_at?.toISOString?.() ?? null,
  createdAt: row.created_at.toISOString(),
});

const toProbe = (row: Record<string, any>) => ProbeSchema.parse({
  sourceId: row.source_id,
  status: row.status,
  contentType: row.content_type,
  byteSize: row.byte_size === null ? null : Number(row.byte_size),
  durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
  width: row.width,
  height: row.height,
  videoCodec: row.video_codec,
  audioCodec: row.audio_codec,
  frameRate: row.frame_rate === null ? null : Number(row.frame_rate),
  probe: row.probe_json,
  error: row.error,
  updatedAt: row.updated_at.toISOString(),
});

const toTranscript = (row: Record<string, any>, segments: Record<string, any>[]) => TranscriptSchema.parse({
  id: row.id,
  jobId: row.job_id,
  status: row.status,
  provider: row.provider,
  language: row.language,
  fullText: row.full_text,
  durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
  segments: segments.map((segment) => ({ startSeconds: Number(segment.start_seconds), endSeconds: Number(segment.end_seconds), text: segment.text })),
  error: row.error,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const toCandidate = (row: Record<string, any>) => {
  const copy = row.social_copy && typeof row.social_copy === 'object' ? row.social_copy : {};
  const audienceSignal = row.audience_signal && typeof row.audience_signal === 'object' ? AudienceSignalSchema.parse(row.audience_signal) : null;
  return CandidateSchema.parse({
    id: row.id,
    jobId: row.job_id,
    transcriptId: row.transcript_id ?? null,
    startSeconds: Number(row.start_seconds),
    endSeconds: Number(row.end_seconds),
    score: row.score === null ? null : Number(row.score),
    confidence: row.confidence === null ? null : Number(row.confidence),
    reviewStatus: row.review_status ?? 'proposed',
    rationale: row.rationale ?? null,
    evidence: Array.isArray(row.evidence) ? row.evidence.map((item: Record<string, any>) => ({ startSeconds: Number(item.startSeconds ?? item.start_seconds), endSeconds: Number(item.endSeconds ?? item.end_seconds), text: item.text })) : [],
    socialCopy: {
      headline: typeof copy.headline === 'string' ? copy.headline : '',
      caption: typeof copy.caption === 'string' ? copy.caption : '',
      hashtags: Array.isArray(copy.hashtags) ? copy.hashtags : [],
      ...(typeof copy.hook === 'string' ? { hook: copy.hook } : {}),
      ...(copy.alternates && typeof copy.alternates === 'object' ? { alternates: copy.alternates } : {}),
      ...(copy.optionalCta === null || typeof copy.optionalCta === 'string' ? { optionalCta: copy.optionalCta } : {}),
      headlineCards: Array.isArray(copy.headlineCards) ? copy.headlineCards : [],
      nameTags: Array.isArray(copy.nameTags) ? copy.nameTags : [],
    },
    audienceSignal,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    editedStartSeconds: row.edited_start_seconds === null ? null : Number(row.edited_start_seconds),
    editedEndSeconds: row.edited_end_seconds === null ? null : Number(row.edited_end_seconds),
    reviewedBy: row.reviewed_by ?? null,
    reviewedAt: row.reviewed_at?.toISOString?.() ?? null,
    notes: row.notes ?? null,
    posted: row.posted ?? false,
    postedBy: row.posted_by ?? null,
    postedAt: row.posted_at?.toISOString?.() ?? null,
    createdAt: row.created_at.toISOString(),
  });
};

const toRender = (row: Record<string, any>) => RenderSchema.parse({
  id: row.id,
  candidateId: row.candidate_id,
  profile: row.profile,
  fitMode: row.fit_mode ?? 'cover',
  background: row.background ?? 'dark_blue',
  logoPosition: row.logo_position ?? 'top-left',
  logoAssetId: row.logo_asset_id ?? null,
  captionMode: row.caption_mode,
  includeLogo: row.include_logo,
  status: row.status,
  progress: row.progress,
  attempts: row.attempts,
  error: row.error ?? null,
  assetId: row.asset_id ?? null,
  captionAssetId: row.caption_asset_id ?? null,
  thumbnailAssetId: row.thumbnail_asset_id ?? null,
  manifestAssetId: row.manifest_asset_id ?? null,
  renderManifest: row.render_manifest ?? null,
  playbackUrl: row.asset_id ? `/v1/assets/${row.asset_id}` : null,
  captionsUrl: row.caption_asset_id ? `/v1/assets/${row.caption_asset_id}` : null,
  thumbnailUrl: row.thumbnail_asset_id ? `/v1/assets/${row.thumbnail_asset_id}` : null,
  manifestUrl: row.manifest_asset_id ? `/v1/assets/${row.manifest_asset_id}` : null,
  createdAt: row.created_at.toISOString(),
  completedAt: row.completed_at?.toISOString?.() ?? null,
});

const toThumbnailProject = (row: Record<string, any>) => ThumbnailProjectSchema.parse({
  id: row.id,
  candidateId: row.candidate_id,
  sourceId: row.source_id,
  frameSeconds: Number(row.frame_seconds),
  sourceHeadlineCardId: row.source_headline_card_id ?? null,
  brandAssetId: row.brand_asset_id ?? null,
  segmentationProvider: row.segmentation_provider,
  positiveBox: row.positive_box ?? null,
  negativeBoxes: Array.isArray(row.negative_boxes) ? row.negative_boxes : [],
  manifest: row.manifest_json ?? null,
  sourceFrameAssetId: row.source_frame_asset_id ?? null,
  subjectAssetId: row.subject_asset_id ?? null,
  previewAssetId: row.preview_asset_id ?? null,
  exportAssetId: row.export_asset_id ?? null,
  sourceFrameUrl: row.source_frame_asset_id ? `/v1/assets/${row.source_frame_asset_id}` : null,
  subjectUrl: row.subject_asset_id ? `/v1/assets/${row.subject_asset_id}` : null,
  previewUrl: row.preview_asset_id ? `/v1/assets/${row.preview_asset_id}` : null,
  exportUrl: row.export_asset_id ? `/v1/assets/${row.export_asset_id}` : null,
  status: row.status,
  error: row.error ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const toThumbnailJob = (row: Record<string, any>) => ThumbnailJobSchema.parse({
  id: row.id,
  thumbnailProjectId: row.thumbnail_project_id,
  status: row.status,
  progress: row.progress,
  attempts: row.attempts,
  claimedAt: row.claimed_at?.toISOString?.() ?? null,
  leaseExpiresAt: row.lease_expires_at?.toISOString?.() ?? null,
  error: row.error ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

function candidateHasHeadlineCard(socialCopy: unknown, headlineCardId: string | null) {
  if (!headlineCardId) return true;
  if (!socialCopy || typeof socialCopy !== 'object') return false;
  const headlineCards = (socialCopy as { headlineCards?: unknown }).headlineCards;
  return Array.isArray(headlineCards) && headlineCards.some((card) => card && typeof card === 'object' && (card as { id?: unknown }).id === headlineCardId);
}

type AudienceRetentionRow = {
  segment_start_seconds: number | string;
  segment_end_seconds: number | string;
  audience_watch_ratio: number | string;
  started_watching: number | string;
};

function hydrateAudienceSignal(signal: unknown, points: AudienceRetentionRow[], startSeconds: number, endSeconds: number) {
  if (!signal || typeof signal !== 'object' || !points.length) return signal;
  const ordered = points
    .map((point) => ({
      start: Number(point.segment_start_seconds),
      end: Number(point.segment_end_seconds),
      watchRatio: Number(point.audience_watch_ratio),
      startedWatching: Number(point.started_watching),
    }))
    .filter((point) => Number.isFinite(point.start) && Number.isFinite(point.end) && Number.isFinite(point.watchRatio) && Number.isFinite(point.startedWatching));
  if (!ordered.length) return signal;

  const selected = ordered.filter((point) => point.end > startSeconds && point.start < endSeconds);
  const nearest = (target: number) => ordered.reduce((closest, point) => {
    const distance = point.end < target ? target - point.end : point.start - target;
    const closestDistance = closest.end < target ? target - closest.end : closest.start - target;
    return distance < closestDistance ? point : closest;
  }, ordered[0]);
  const startPoint = selected[0] ?? nearest(startSeconds);
  const endPoint = selected.at(-1) ?? nearest(endSeconds);
  const raw = (signal as { raw?: unknown }).raw;
  const existingRaw = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    ...(signal as Record<string, unknown>),
    raw: {
      ...existingRaw,
      startAudienceWatchRatio: existingRaw.startAudienceWatchRatio ?? startPoint.watchRatio,
      endAudienceWatchRatio: existingRaw.endAudienceWatchRatio ?? endPoint.watchRatio,
      startStartedWatching: existingRaw.startStartedWatching ?? startPoint.startedWatching,
    },
  };
}

const toBrandAsset = (row: Record<string, any>) => BrandAssetSchema.parse({
  id: row.id,
  name: row.name,
  show: row.show,
  assetId: row.asset_id,
  assetUrl: `/v1/assets/${row.asset_id}`,
  contentType: row.content_type ?? null,
  active: row.active,
  createdAt: row.created_at.toISOString(),
});

const toYouTubeVideo = (row: Record<string, any>) => YouTubeVideoSchema.parse({
  id: row.id,
  youtubeVideoId: row.youtube_video_id,
  canonicalUrl: row.canonical_url,
  title: row.title,
  description: row.description ?? null,
  channel: row.channel_db_id ? {
    id: row.channel_db_id,
    youtubeChannelId: row.youtube_channel_id,
    handle: row.channel_handle ?? null,
    name: row.channel_name_value ?? null,
  } : null,
  mediaSourceId: row.media_source_id ?? null,
  publishedAt: row.published_at?.toISOString?.() ?? null,
  uploadDate: row.upload_date ? String(row.upload_date) : null,
  durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
  availability: row.availability ?? null,
  liveStatus: row.live_status ?? null,
  thumbnailUrl: row.thumbnail_url ?? null,
  viewCount: row.view_count === null ? null : Number(row.view_count),
  likeCount: row.like_count === null ? null : Number(row.like_count),
  commentCount: row.comment_count === null ? null : Number(row.comment_count),
  archivePath: row.archive_path ?? null,
  archiveFilename: row.archive_filename ?? null,
  archiveByteSize: row.archive_byte_size === null ? null : Number(row.archive_byte_size),
  ingestionStatus: row.ingestion_status,
  ingestionJobId: row.ingestion_job_id ?? null,
  ingestionRequestedAt: row.ingestion_requested_at?.toISOString?.() ?? null,
  ingestionError: row.ingestion_error ?? null,
  candidateCount: Number(row.candidate_count ?? 0),
  firstSeenAt: row.first_seen_at.toISOString(),
  lastSeenAt: row.last_seen_at.toISOString(),
  lastMetadataSyncAt: row.last_metadata_sync_at?.toISOString?.() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const toYouTubeChannel = (row: Record<string, any>) => YouTubeChannelSchema.parse({
  id: row.id,
  youtubeChannelId: row.youtube_channel_id,
  handle: row.handle ?? null,
  name: row.name ?? null,
  uploadsPlaylistId: row.uploads_playlist_id ?? null,
  active: row.active,
  syncStatus: row.sync_status,
  lastSyncedAt: row.last_synced_at?.toISOString?.() ?? null,
  lastSyncedPublishedAt: row.last_synced_published_at?.toISOString?.() ?? null,
  lastError: row.last_error ?? null,
  videoCount: Number(row.video_count ?? 0),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const dashboardSelect = `
  SELECT c.*, j.source_id, j.status AS job_status, j.progress AS job_progress, j.last_error AS job_error,
    s.source_type, s.media_type, s.uri AS source_uri, s.metadata AS source_metadata,
    y.published_at AS youtube_published_at, y.upload_date AS youtube_upload_date,
    p.status AS probe_status, p.duration_seconds, p.width, p.height,
    sa.id AS source_asset_id,
    r.id AS render_id, r.profile AS render_profile, r.fit_mode AS render_fit_mode, r.background AS render_background, r.logo_position AS render_logo_position, r.logo_asset_id AS render_logo_asset_id, r.caption_mode AS render_caption_mode,
    r.include_logo AS render_include_logo, r.status AS render_status, r.progress AS render_progress,
    r.attempts AS render_attempts, r.error AS render_error, r.asset_id AS render_asset_id,
    r.caption_asset_id AS render_caption_asset_id, r.thumbnail_asset_id AS render_thumbnail_asset_id,
    r.manifest_asset_id AS render_manifest_asset_id, r.render_manifest, r.created_at AS render_created_at,
    r.completed_at AS render_completed_at,
    audience.signal AS audience_signal
  FROM clip_candidates c
  JOIN processing_jobs j ON j.id=c.job_id
  JOIN media_sources s ON s.id=j.source_id
  LEFT JOIN youtube_videos y ON y.media_source_id=j.source_id
  LEFT JOIN source_probes p ON p.source_id=j.source_id
  LEFT JOIN LATERAL (
    SELECT id FROM assets WHERE source_id=j.source_id AND role='source' ORDER BY created_at DESC LIMIT 1
  ) sa ON true
  LEFT JOIN LATERAL (
    SELECT * FROM clip_renders WHERE candidate_id=c.id ORDER BY created_at DESC LIMIT 1
  ) r ON true
  LEFT JOIN LATERAL (
    SELECT s.signal
    FROM youtube_audience_clip_snapshots s
    WHERE s.candidate_id=c.id
    ORDER BY s.collected_at DESC
    LIMIT 1
  ) audience ON true
  WHERE ($1::uuid IS NULL OR c.id=$1)
    AND ($2::text IS NULL OR c.metadata::text ILIKE $2 OR c.social_copy::text ILIKE $2 OR s.metadata::text ILIKE $2 OR s.uri ILIKE $2
      OR EXISTS (SELECT 1 FROM transcripts t WHERE t.job_id=c.job_id AND t.full_text ILIKE $2)
      OR EXISTS (SELECT 1 FROM transcripts t JOIN transcript_segments ts ON ts.transcript_id=t.id WHERE t.job_id=c.job_id AND ts.text ILIKE $2))
  ORDER BY y.published_at DESC NULLS LAST, y.upload_date DESC NULLS LAST, c.created_at DESC
  LIMIT $3`;

async function loadDashboardRows(db: pg.Pool, candidateId: string | null, query: string | null, limit: number) {
  return (await db.query(dashboardSelect, [candidateId, query ? `%${query}%` : null, limit])).rows;
}

const toDashboardClip = (row: Record<string, any>) => {
  const render = row.render_id ? toRender({
    id: row.render_id,
    candidate_id: row.id,
    profile: row.render_profile,
    fit_mode: row.render_fit_mode ?? 'cover',
    background: row.render_background ?? 'dark_blue',
    logo_position: row.render_logo_position ?? 'top-left',
    logo_asset_id: row.render_logo_asset_id ?? null,
    caption_mode: row.render_caption_mode,
    include_logo: row.render_include_logo,
    status: row.render_status,
    progress: row.render_progress,
    attempts: row.render_attempts,
    error: row.render_error,
    asset_id: row.render_asset_id,
    caption_asset_id: row.render_caption_asset_id,
    thumbnail_asset_id: row.render_thumbnail_asset_id,
    manifest_asset_id: row.render_manifest_asset_id,
    render_manifest: row.render_manifest,
    created_at: row.render_created_at,
    completed_at: row.render_completed_at,
  }) : null;
  return {
    ...toCandidate(row),
    source: {
      id: row.source_id,
      sourceType: row.source_type,
      mediaType: row.media_type,
      uri: row.source_uri,
      metadata: row.source_metadata ?? {},
      assetUrl: row.source_asset_id ? `/v1/assets/${row.source_asset_id}` : null,
      durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
      width: row.width ?? null,
      height: row.height ?? null,
    },
    job: { id: row.job_id, status: row.job_status, progress: row.job_progress, error: row.job_error ?? null },
    render,
  };
};

const MultipartUploadPrepareSchema = z.object({
  filename: z.string().min(1).max(500),
  contentType: z.string().min(1).max(255).default('application/octet-stream'),
  byteSize: z.number().int().positive(),
  mediaType: z.enum(['video', 'audio']).default('video'),
  sourceTitle: z.string().max(500).default(''),
});

const MultipartUploadCompleteSchema = z.object({
  parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(512) })).min(1).max(10_000),
});

type PendingUpload = {
  uploadId: string;
  storageKey: string;
  expectedByteSize: number;
  contentType: string;
  originalFilename: string;
  sourceTitle: string;
  mediaType: 'video' | 'audio';
  partSizeBytes: number;
  totalParts: number;
};

function multipartStoreFor(store: AssetStore): (AssetStore & MultipartAssetStore) | null {
  const candidate = store as AssetStore & Partial<MultipartAssetStore>;
  if (
    typeof candidate.createMultipartUpload !== 'function'
    || typeof candidate.uploadPart !== 'function'
    || typeof candidate.completeMultipartUpload !== 'function'
    || typeof candidate.abortMultipartUpload !== 'function'
    || typeof candidate.head !== 'function'
  ) return null;
  return candidate as AssetStore & MultipartAssetStore;
}

function pendingUploadFromSource(row: Record<string, any>): PendingUpload | null {
  const upload = row.metadata?.uploadSession;
  if (!upload || typeof upload !== 'object') return null;
  if (typeof upload.completedAt === 'string' && upload.completedAt) return null;
  const parsed = {
    uploadId: upload.uploadId,
    storageKey: upload.storageKey,
    expectedByteSize: Number(upload.expectedByteSize),
    contentType: upload.contentType,
    originalFilename: upload.originalFilename,
    sourceTitle: upload.sourceTitle ?? '',
    mediaType: upload.mediaType,
    partSizeBytes: Number(upload.partSizeBytes),
    totalParts: Number(upload.totalParts),
  };
  if (
    typeof parsed.uploadId !== 'string'
    || typeof parsed.storageKey !== 'string'
    || !Number.isSafeInteger(parsed.expectedByteSize)
    || parsed.expectedByteSize <= 0
    || typeof parsed.contentType !== 'string'
    || typeof parsed.originalFilename !== 'string'
    || (parsed.mediaType !== 'video' && parsed.mediaType !== 'audio')
    || !Number.isSafeInteger(parsed.partSizeBytes)
    || parsed.partSizeBytes < 5 * 1024 * 1024
    || !Number.isSafeInteger(parsed.totalParts)
    || parsed.totalParts < 1
  ) return null;
  return parsed;
}

export function buildApp(db: pg.Pool, store: AssetStore, maxUploadBytes = 5_000_000_000) {
  const uploadPartBytes = Math.max(5 * 1024 * 1024, Number(process.env.UPLOAD_PART_BYTES ?? 64 * 1024 * 1024));
  const app = Fastify({ logger: true, bodyLimit: uploadPartBytes + 1024 * 1024 });
  const youtubeApiKey = process.env.YOUTUBE_DATA_API_KEY?.trim();
  const youtubeSync = youtubeApiKey ? new YouTubeCatalogSync(db, new YouTubeDataApiClient(youtubeApiKey), Number(process.env.YOUTUBE_SYNC_MAX_PAGES ?? 100)) : null;
  const youtubeIngestion = new YouTubeIngestionService(db);
  app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 1 } });
  // Fastify's built-in parser types are buffer/string. This only buffers one
  // bounded part (64 MiB by default), never the complete source file.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'invalid_request', details: error.issues });
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'file_too_large' });
    request.log.error(error);
    return reply.code(500).send({ error: 'internal_error' });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  app.get('/v1/brand-assets', async () => {
    const result = await db.query('SELECT b.id,b.name,b.show,b.asset_id,b.active,b.created_at,a.content_type FROM brand_assets b JOIN assets a ON a.id=b.asset_id WHERE b.active=true ORDER BY b.show,b.created_at DESC');
    return { items: result.rows.map(toBrandAsset) };
  });

  app.get('/v1/youtube/videos', async (request) => {
    const query = request.query as { q?: string; status?: string; limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
    const values: unknown[] = [];
    const where: string[] = [];
    if (query.q?.trim()) {
      values.push(`%${query.q.trim()}%`);
      const param = `$${values.length}`;
      where.push(`(v.title ILIKE ${param} OR COALESCE(v.description, '') ILIKE ${param} OR v.canonical_url ILIKE ${param} OR v.youtube_video_id ILIKE ${param})`);
    }
    if (query.status?.trim()) {
      values.push(query.status.trim());
      where.push(`v.ingestion_status = $${values.length}`);
    }
    values.push(limit, offset);
    const limitParam = `$${values.length - 1}`;
    const offsetParam = `$${values.length}`;
    const result = await db.query(`
      SELECT v.*, ch.id AS channel_db_id, ch.youtube_channel_id, ch.handle AS channel_handle, ch.name AS channel_name_value,
        (SELECT COUNT(*) FROM clip_candidates c JOIN processing_jobs j ON j.id=c.job_id WHERE j.source_id=v.media_source_id) AS candidate_count
      FROM youtube_videos v
      LEFT JOIN youtube_channels ch ON ch.id=v.channel_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY v.published_at DESC NULLS LAST, v.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `, values);
    return { items: result.rows.map(toYouTubeVideo), limit, offset };
  });

  app.get('/v1/youtube/channels', async () => {
    const result = await db.query('SELECT c.*, (SELECT COUNT(*) FROM youtube_videos v WHERE v.channel_id=c.id) AS video_count FROM youtube_channels c ORDER BY c.name NULLS LAST, c.created_at');
    return { items: result.rows.map(toYouTubeChannel) };
  });

  const runYouTubeSync = async (identifier: string, body: unknown, reply: any) => {
    if (!youtubeSync) return reply.code(503).send({ error: 'youtube_api_key_missing', message: 'Set YOUTUBE_DATA_API_KEY on the API service before syncing YouTube.' });
    const input = YouTubeSyncRequestSchema.parse(body ?? {});
    try {
      return await youtubeSync.syncChannel(identifier, input);
    } catch (error) {
      if (error instanceof YouTubeSyncError) return reply.code(error.httpStatus).send({ error: error.code, message: error.message });
      throw error;
    }
  };

  app.post('/v1/youtube/channels/:channelId/sync', async (request, reply) => {
    const { channelId } = request.params as { channelId: string };
    return runYouTubeSync(channelId, request.body, reply);
  });

  app.post('/v1/youtube/sync', async (request, reply) => {
    const body = (request.body ?? {}) as { channelId?: string; fullScan?: boolean; maxPages?: number };
    const channelId = body.channelId?.trim() || process.env.YOUTUBE_CHANNEL_ID?.trim();
    if (!channelId) return reply.code(400).send({ error: 'youtube_channel_id_required', message: 'Provide channelId or set YOUTUBE_CHANNEL_ID.' });
    return runYouTubeSync(channelId, body, reply);
  });

  const runYouTubeIngest = async (body: unknown) => {
    const input = YouTubeIngestRequestSchema.parse(body ?? {});
    return youtubeIngestion.enqueue(input);
  };

  app.post('/v1/youtube/ingest', async (request) => runYouTubeIngest(request.body));

  app.post('/v1/youtube/videos/:videoId/ingest', async (request) => {
    const { videoId } = request.params as { videoId: string };
    const input = YouTubeIngestRequestSchema.parse(request.body ?? {});
    return runYouTubeIngest({ ...input, videoIds: [videoId], limit: 1 });
  });

  app.post('/v1/youtube/automation/run', async (request, reply) => {
    if (!youtubeSync) return reply.code(503).send({ error: 'youtube_api_key_missing', message: 'Set YOUTUBE_DATA_API_KEY on the API service before running YouTube automation.' });
    const body = (request.body ?? {}) as { channelId?: string; fullScan?: boolean; maxPages?: number; videoIds?: string[]; limit?: number; mode?: 'whole_media' | 'find_moments' | 'transcribe_only'; dryRun?: boolean };
    const channelId = body.channelId?.trim() || process.env.YOUTUBE_CHANNEL_ID?.trim();
    if (!channelId) return reply.code(400).send({ error: 'youtube_channel_id_required', message: 'Provide channelId or set YOUTUBE_CHANNEL_ID.' });
    try {
      const sync = await youtubeSync.syncChannel(channelId, YouTubeSyncRequestSchema.parse(body));
      const ingestion = await youtubeIngestion.enqueue({ ...YouTubeIngestRequestSchema.parse(body), channelId });
      return { sync, ingestion };
    } catch (error) {
      if (error instanceof YouTubeSyncError) return reply.code(error.httpStatus).send({ error: error.code, message: error.message });
      throw error;
    }
  });

  app.get('/v1/youtube/videos/:videoId', async (request, reply) => {
    const { videoId } = request.params as { videoId: string };
    const result = await db.query(`
      SELECT v.*, ch.id AS channel_db_id, ch.youtube_channel_id, ch.handle AS channel_handle, ch.name AS channel_name_value,
        (SELECT COUNT(*) FROM clip_candidates c JOIN processing_jobs j ON j.id=c.job_id WHERE j.source_id=v.media_source_id) AS candidate_count
      FROM youtube_videos v
      LEFT JOIN youtube_channels ch ON ch.id=v.channel_id
      WHERE v.youtube_video_id=$1 OR v.id::text=$1
      LIMIT 1
    `, [videoId]);
    return result.rowCount ? toYouTubeVideo(result.rows[0]) : reply.code(404).send({ error: 'youtube_video_not_found' });
  });

  app.post('/v1/brand-assets', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'file_required' });
    const nameHeader = request.headers['x-brand-name'];
    const showHeader = request.headers['x-brand-show'];
    const show = typeof showHeader === 'string' ? showHeader.trim().slice(0, 255) : '';
    const name = typeof nameHeader === 'string' && nameHeader.trim() ? nameHeader.trim().slice(0, 255) : `${show} logo`;
    if (!show) return reply.code(400).send({ error: 'brand_show_required' });
    if (!name) return reply.code(400).send({ error: 'brand_name_required' });
    if (!file.mimetype.startsWith('image/')) return reply.code(400).send({ error: 'brand_asset_must_be_image' });

    const brandAssetId = randomUUID();
    const safeName = (file.filename || 'logo.bin').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'logo.bin';
    const storageKey = `brand-assets/${brandAssetId}/${safeName}`;
    try {
      const stored = await store.putStream(storageKey, file.file);
      if (file.file.truncated) throw new Error('file_too_large');
      const asset = await db.query("INSERT INTO assets(source_id,storage_key,role,content_type,byte_size,public_reference,metadata) VALUES(NULL,$1,'other',$2,$3,$4,$5) RETURNING id", [storageKey, file.mimetype, stored.byteSize, store.getPublicReference(storageKey), { originalFilename: file.filename, brandAsset: true }]);
      const brand = await db.query('INSERT INTO brand_assets(id,name,show,asset_id) VALUES($1,$2,$3,$4) RETURNING *', [brandAssetId, name, show, asset.rows[0].id]);
      return reply.code(201).send(toBrandAsset({ ...brand.rows[0], asset_id: asset.rows[0].id, content_type: file.mimetype }));
    } catch (error) {
      await store.delete(storageKey);
      await db.query('DELETE FROM brand_assets WHERE id=$1', [brandAssetId]);
      await db.query('DELETE FROM assets WHERE storage_key=$1', [storageKey]);
      if (error instanceof Error && error.message === 'file_too_large') return reply.code(413).send({ error: 'file_too_large' });
      throw error;
    }
  });

  app.post('/v1/sources', async (request, reply) => {
    const input = CreateSourceSchema.parse(request.body);
    const result = await db.query("INSERT INTO media_sources(source_type,media_type,uri,canonical_url,provider,metadata) VALUES($1,$2,$3,CASE WHEN $1='platform_url' THEN $3 ELSE NULL END,$4,$5) RETURNING *", [input.sourceType, input.mediaType, input.uri, input.provider ?? null, input.metadata]);
    const row = result.rows[0];
    return reply.code(201).send({ id: row.id, sourceType: row.source_type, mediaType: row.media_type, uri: row.uri, canonicalUrl: row.canonical_url, provider: row.provider, metadata: row.metadata, createdAt: row.created_at.toISOString() });
  });

  // The hosted dashboard runs behind a Cloudflare Worker, whose request body
  // limit is much smaller than the 5 GB source limit. Keep each part below
  // that edge limit and assemble the object in R2 without buffering it in the
  // API process.
  app.post('/v1/uploads/multipart', async (request, reply) => {
    const multipartStore = multipartStoreFor(store);
    if (!multipartStore) return reply.code(501).send({ error: 'multipart_upload_unavailable' });
    const input = MultipartUploadPrepareSchema.parse(request.body);
    if (input.byteSize > maxUploadBytes) return reply.code(413).send({ error: 'file_too_large' });

    const sourceId = randomUUID();
    const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'upload.bin';
    const storageKey = `uploads/${sourceId}/${safeName}`;
    const totalParts = Math.ceil(input.byteSize / uploadPartBytes);
    const upload = await multipartStore.createMultipartUpload(storageKey, input.contentType);
    const session: PendingUpload = {
      uploadId: upload.uploadId,
      storageKey,
      expectedByteSize: input.byteSize,
      contentType: input.contentType,
      originalFilename: input.filename,
      sourceTitle: input.sourceTitle.trim(),
      mediaType: input.mediaType,
      partSizeBytes: uploadPartBytes,
      totalParts,
    };
    try {
      await db.query("INSERT INTO media_sources(id,source_type,media_type,uri,metadata) VALUES($1,'upload',$2,$3,$4)", [
        sourceId,
        input.mediaType,
        store.getPublicReference(storageKey),
        {
          originalFilename: input.filename,
          uploadedContentType: input.contentType,
          ...(input.sourceTitle.trim() ? { title: input.sourceTitle.trim() } : {}),
          uploadSession: session,
        },
      ]);
    } catch (error) {
      await multipartStore.abortMultipartUpload(storageKey, upload.uploadId).catch(() => undefined);
      throw error;
    }
    return reply.code(201).send({
      sourceId,
      uploadId: upload.uploadId,
      partSizeBytes: uploadPartBytes,
      totalParts,
    });
  });

  app.post('/v1/uploads/multipart/:sourceId/parts/:partNumber', async (request, reply) => {
    const multipartStore = multipartStoreFor(store);
    if (!multipartStore) return reply.code(501).send({ error: 'multipart_upload_unavailable' });
    const { sourceId, partNumber: rawPartNumber } = request.params as { sourceId: string; partNumber: string };
    const partNumber = Number(rawPartNumber);
    const source = await db.query('SELECT id,source_type,metadata FROM media_sources WHERE id=$1', [sourceId]);
    if (!source.rowCount || source.rows[0].source_type !== 'upload') return reply.code(404).send({ error: 'upload_not_found' });
    const session = pendingUploadFromSource(source.rows[0]);
    if (!session) return reply.code(409).send({ error: 'upload_not_pending' });
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.totalParts) return reply.code(400).send({ error: 'invalid_part_number' });

    const sizeHeader = request.headers['x-upload-part-size'] ?? request.headers['content-length'];
    const contentLength = Number(Array.isArray(sizeHeader) ? sizeHeader[0] : sizeHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > session.partSizeBytes) return reply.code(400).send({ error: 'invalid_part_size' });
    const expectedPartSize = partNumber < session.totalParts
      ? session.partSizeBytes
      : session.expectedByteSize - (session.totalParts - 1) * session.partSizeBytes;
    if (contentLength !== expectedPartSize) return reply.code(400).send({ error: 'unexpected_part_size', expected: expectedPartSize, received: contentLength });

    const body = request.body as Buffer;
    const result = await multipartStore.uploadPart(session.storageKey, session.uploadId, partNumber, Readable.from(body), contentLength);
    return reply.send({ partNumber, etag: result.etag });
  });

  app.post('/v1/uploads/multipart/:sourceId/complete', async (request, reply) => {
    const multipartStore = multipartStoreFor(store);
    if (!multipartStore) return reply.code(501).send({ error: 'multipart_upload_unavailable' });
    const { sourceId } = request.params as { sourceId: string };
    const input = MultipartUploadCompleteSchema.parse(request.body);
    const source = await db.query('SELECT id,source_type,media_type,uri,metadata,created_at FROM media_sources WHERE id=$1', [sourceId]);
    if (!source.rowCount || source.rows[0].source_type !== 'upload') return reply.code(404).send({ error: 'upload_not_found' });
    const existingAsset = await db.query("SELECT id,storage_key,content_type,byte_size,public_reference FROM assets WHERE source_id=$1 AND role='source' ORDER BY created_at DESC LIMIT 1", [sourceId]);
    if (existingAsset.rowCount) return reply.send({ source: { id: sourceId, sourceType: 'upload', mediaType: source.rows[0].media_type, uri: source.rows[0].uri }, asset: existingAsset.rows[0] });
    const session = pendingUploadFromSource(source.rows[0]);
    if (!session) {
      return reply.code(409).send({ error: 'upload_not_pending' });
    }
    const partNumbers = input.parts.map((part) => part.partNumber);
    if (new Set(partNumbers).size !== partNumbers.length || partNumbers.length !== session.totalParts || partNumbers.some((partNumber, index) => partNumber !== index + 1)) {
      return reply.code(400).send({ error: 'invalid_multipart_parts' });
    }

    await multipartStore.completeMultipartUpload(session.storageKey, session.uploadId, input.parts);
    const object = await multipartStore.head(session.storageKey);
    if (object.byteSize !== session.expectedByteSize) {
      await store.delete(session.storageKey).catch(() => undefined);
      await db.query('DELETE FROM media_sources WHERE id=$1', [sourceId]);
      return reply.code(400).send({ error: 'upload_size_mismatch', expected: session.expectedByteSize, received: object.byteSize });
    }
    const metadata = { ...(source.rows[0].metadata ?? {}), uploadSession: { ...session, completedAt: new Date().toISOString() } };
    const asset = await db.query("INSERT INTO assets(source_id,storage_key,role,content_type,byte_size,public_reference,metadata) VALUES($1,$2,'source',$3,$4,$5,$6) RETURNING id,storage_key,content_type,byte_size,public_reference", [sourceId, session.storageKey, object.contentType ?? session.contentType, object.byteSize, store.getPublicReference(session.storageKey), { originalFilename: session.originalFilename }]);
    await db.query('UPDATE media_sources SET metadata=$2 WHERE id=$1', [sourceId, metadata]);
    return reply.code(201).send({ source: { id: sourceId, sourceType: 'upload', mediaType: session.mediaType, uri: store.getPublicReference(session.storageKey) }, asset: asset.rows[0] });
  });

  app.post('/v1/uploads/multipart/:sourceId/abort', async (request, reply) => {
    const multipartStore = multipartStoreFor(store);
    if (!multipartStore) return reply.code(501).send({ error: 'multipart_upload_unavailable' });
    const { sourceId } = request.params as { sourceId: string };
    const source = await db.query('SELECT metadata FROM media_sources WHERE id=$1', [sourceId]);
    if (!source.rowCount) return reply.code(404).send({ error: 'upload_not_found' });
    const session = pendingUploadFromSource(source.rows[0]);
    if (session) await multipartStore.abortMultipartUpload(session.storageKey, session.uploadId).catch(() => undefined);
    const existingAsset = await db.query("SELECT id FROM assets WHERE source_id=$1 AND role='source' LIMIT 1", [sourceId]);
    if (!existingAsset.rowCount) await db.query('DELETE FROM media_sources WHERE id=$1', [sourceId]);
    return reply.code(204).send();
  });

  app.post('/v1/uploads', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'file_required' });
    const mediaTypeHeader = request.headers['x-media-type'];
    const mediaType = mediaTypeHeader === 'audio' ? 'audio' : 'video';
    const sourceTitleHeader = request.headers['x-source-title'];
    const sourceTitle = typeof sourceTitleHeader === 'string' ? sourceTitleHeader.trim().slice(0, 500) : '';
    const sourceId = randomUUID();
    const safeName = (file.filename || 'upload.bin').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'upload.bin';
    const storageKey = `uploads/${sourceId}/${safeName}`;
    await db.query("INSERT INTO media_sources(id,source_type,media_type,uri,metadata) VALUES($1,'upload',$2,$3,$4)", [sourceId, mediaType, store.getPublicReference(storageKey), { originalFilename: file.filename, uploadedContentType: file.mimetype, ...(sourceTitle ? { title: sourceTitle } : {}) }]);
    try {
      const stored = await store.putStream(storageKey, file.file);
      if (file.file.truncated) throw new Error('file_too_large');
      const asset = await db.query("INSERT INTO assets(source_id,storage_key,role,content_type,byte_size,public_reference,metadata) VALUES($1,$2,'source',$3,$4,$5,$6) RETURNING id,storage_key,content_type,byte_size,public_reference", [sourceId, storageKey, file.mimetype, stored.byteSize, store.getPublicReference(storageKey), { originalFilename: file.filename }]);
      return reply.code(201).send({ source: { id: sourceId, sourceType: 'upload', mediaType, uri: store.getPublicReference(storageKey) }, asset: asset.rows[0] });
    } catch (error) {
      await store.delete(storageKey);
      await db.query('DELETE FROM media_sources WHERE id=$1', [sourceId]);
      if (error instanceof Error && error.message === 'file_too_large') return reply.code(413).send({ error: 'file_too_large' });
      throw error;
    }
  });

  app.get('/v1/sources/:sourceId', async (request, reply) => {
    const { sourceId } = request.params as { sourceId: string };
    const source = await db.query('SELECT * FROM media_sources WHERE id=$1', [sourceId]);
    if (!source.rowCount) return reply.code(404).send({ error: 'source_not_found' });
    const [assets, probe] = await Promise.all([
      db.query('SELECT id,storage_key,role,content_type,byte_size,public_reference,metadata,created_at FROM assets WHERE source_id=$1 ORDER BY created_at DESC', [sourceId]),
      db.query('SELECT * FROM source_probes WHERE source_id=$1', [sourceId]),
    ]);
    const row = source.rows[0];
    return { id: row.id, sourceType: row.source_type, mediaType: row.media_type, uri: row.uri, canonicalUrl: row.canonical_url, provider: row.provider, metadata: row.metadata, createdAt: row.created_at.toISOString(), assets: assets.rows, probe: probe.rowCount ? toProbe(probe.rows[0]) : null };
  });

  app.post('/v1/jobs', async (request, reply) => {
    const input = CreateJobSchema.parse(request.body);
    const source = await db.query('SELECT id FROM media_sources WHERE id=$1', [input.sourceId]);
    if (!source.rowCount) return reply.code(404).send({ error: 'source_not_found' });
    const result = await db.query('INSERT INTO processing_jobs(source_id,mode,idempotency_key) VALUES($1,$2,$3) ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *', [input.sourceId, input.mode, input.idempotencyKey]);
    return reply.code(201).send(toJob(result.rows[0]));
  });

  app.get('/v1/jobs/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const result = await db.query('SELECT * FROM processing_jobs WHERE id=$1', [jobId]);
    return result.rowCount ? toJob(result.rows[0]) : reply.code(404).send({ error: 'job_not_found' });
  });

  app.get('/v1/jobs/:jobId/transcript', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const transcript = await db.query('SELECT * FROM transcripts WHERE job_id=$1', [jobId]);
    if (!transcript.rowCount) return reply.code(404).send({ error: 'transcript_not_found' });
    const segments = await db.query('SELECT start_seconds,end_seconds,text FROM transcript_segments WHERE transcript_id=$1 ORDER BY start_seconds', [transcript.rows[0].id]);
    return toTranscript(transcript.rows[0], segments.rows);
  });

  app.get('/v1/jobs/:jobId/candidates', async (request) => {
    const { jobId } = request.params as { jobId: string };
    const status = (request.query as { status?: string }).status;
    const result = status
      ? await db.query('SELECT * FROM clip_candidates WHERE job_id=$1 AND review_status=$2 ORDER BY score DESC NULLS LAST, created_at', [jobId, status])
      : await db.query('SELECT * FROM clip_candidates WHERE job_id=$1 ORDER BY score DESC NULLS LAST, created_at', [jobId]);
    return { items: result.rows.map(toCandidate) };
  });

  app.get('/v1/candidates/:candidateId', async (request, reply) => {
    const { candidateId } = request.params as { candidateId: string };
    const result = await db.query('SELECT * FROM clip_candidates WHERE id=$1', [candidateId]);
    return result.rowCount ? toCandidate(result.rows[0]) : reply.code(404).send({ error: 'candidate_not_found' });
  });

  app.post('/v1/candidates/:candidateId/thumbnails', async (request, reply) => {
    const { candidateId } = request.params as { candidateId: string };
    const input = ThumbnailCreateSchema.parse(request.body ?? {});
    const candidate = await db.query(`
      SELECT candidate.id,candidate.start_seconds,candidate.edited_start_seconds,candidate.social_copy,
        job.source_id,source.media_type,probe.duration_seconds
      FROM clip_candidates AS candidate
      JOIN processing_jobs AS job ON job.id=candidate.job_id
      JOIN media_sources AS source ON source.id=job.source_id
      LEFT JOIN source_probes AS probe ON probe.source_id=job.source_id
      WHERE candidate.id=$1
    `, [candidateId]);
    if (!candidate.rowCount) return reply.code(404).send({ error: 'candidate_not_found' });
    const candidateRow = candidate.rows[0];
    if (candidateRow.media_type !== 'video') return reply.code(400).send({ error: 'thumbnail_source_must_be_video' });
    const frameSeconds = input.frameSeconds ?? Number(candidateRow.edited_start_seconds ?? candidateRow.start_seconds);
    const durationSeconds = candidateRow.duration_seconds === null ? null : Number(candidateRow.duration_seconds);
    if (!Number.isFinite(frameSeconds) || frameSeconds < 0 || (durationSeconds !== null && frameSeconds > durationSeconds)) {
      return reply.code(400).send({ error: 'invalid_thumbnail_frame' });
    }
    if (!candidateHasHeadlineCard(candidateRow.social_copy, input.sourceHeadlineCardId)) return reply.code(400).send({ error: 'headline_card_not_found' });
    if (input.brandAssetId) {
      const brand = await db.query('SELECT 1 FROM brand_assets WHERE id=$1 AND active=true', [input.brandAssetId]);
      if (!brand.rowCount) return reply.code(400).send({ error: 'brand_asset_not_found' });
    }
    const configuredProvider = input.segmentationProvider
      ?? (process.env.THUMBNAIL_SEGMENTATION_PROVIDER === 'sam3' || process.env.THUMBNAIL_SEGMENTATION_PROVIDER === 'u2netp' ? process.env.THUMBNAIL_SEGMENTATION_PROVIDER : undefined);
    const segmentationProvider = configuredProvider ?? (input.positiveBox ? 'sam3' : 'u2netp');
    if (segmentationProvider === 'sam3' && !input.positiveBox) return reply.code(400).send({ error: 'sam3_positive_box_required' });

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const project = await client.query(`
        INSERT INTO thumbnail_projects(candidate_id,source_id,frame_seconds,source_headline_card_id,brand_asset_id,segmentation_provider,positive_box,negative_boxes)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
        RETURNING *
      `, [candidateId, candidateRow.source_id, frameSeconds, input.sourceHeadlineCardId, input.brandAssetId, segmentationProvider, input.positiveBox ? JSON.stringify(input.positiveBox) : null, JSON.stringify(input.negativeBoxes)]);
      const job = await client.query('INSERT INTO thumbnail_jobs(thumbnail_project_id) VALUES($1) RETURNING *', [project.rows[0].id]);
      await client.query('COMMIT');
      return reply.code(201).send({ project: toThumbnailProject(project.rows[0]), job: toThumbnailJob(job.rows[0]) });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/v1/thumbnails/:thumbnailId', async (request, reply) => {
    const { thumbnailId } = request.params as { thumbnailId: string };
    const project = await db.query('SELECT * FROM thumbnail_projects WHERE id=$1', [thumbnailId]);
    if (!project.rowCount) return reply.code(404).send({ error: 'thumbnail_not_found' });
    const jobs = await db.query('SELECT * FROM thumbnail_jobs WHERE thumbnail_project_id=$1 ORDER BY created_at DESC', [thumbnailId]);
    return { project: toThumbnailProject(project.rows[0]), jobs: jobs.rows.map(toThumbnailJob) };
  });

  app.patch('/v1/thumbnails/:thumbnailId', async (request, reply) => {
    const { thumbnailId } = request.params as { thumbnailId: string };
    const input = ThumbnailCreateSchema.partial().parse(request.body ?? {});
    if (!Object.keys(input).length) return reply.code(400).send({ error: 'thumbnail_update_required' });
    const current = await db.query(`
      SELECT project.*,candidate.social_copy,probe.duration_seconds
      FROM thumbnail_projects AS project
      JOIN clip_candidates AS candidate ON candidate.id=project.candidate_id
      LEFT JOIN source_probes AS probe ON probe.source_id=project.source_id
      WHERE project.id=$1
    `, [thumbnailId]);
    if (!current.rowCount) return reply.code(404).send({ error: 'thumbnail_not_found' });
    const row = current.rows[0];
    if (row.status === 'processing' || row.status === 'exporting') return reply.code(409).send({ error: 'thumbnail_busy' });
    const frameSeconds = input.frameSeconds ?? Number(row.frame_seconds);
    const durationSeconds = row.duration_seconds === null ? null : Number(row.duration_seconds);
    if (!Number.isFinite(frameSeconds) || frameSeconds < 0 || (durationSeconds !== null && frameSeconds > durationSeconds)) return reply.code(400).send({ error: 'invalid_thumbnail_frame' });
    const sourceHeadlineCardId = input.sourceHeadlineCardId === undefined ? row.source_headline_card_id : input.sourceHeadlineCardId;
    if (!candidateHasHeadlineCard(row.social_copy, sourceHeadlineCardId)) return reply.code(400).send({ error: 'headline_card_not_found' });
    const brandAssetId = input.brandAssetId === undefined ? row.brand_asset_id : input.brandAssetId;
    if (brandAssetId) {
      const brand = await db.query('SELECT 1 FROM brand_assets WHERE id=$1 AND active=true', [brandAssetId]);
      if (!brand.rowCount) return reply.code(400).send({ error: 'brand_asset_not_found' });
    }
    const positiveBox = input.positiveBox === undefined ? row.positive_box : input.positiveBox;
    const negativeBoxes = input.negativeBoxes === undefined ? row.negative_boxes : input.negativeBoxes;
    const segmentationProvider = input.segmentationProvider
      ?? (input.positiveBox !== undefined ? (positiveBox ? 'sam3' : 'u2netp') : row.segmentation_provider);
    if (segmentationProvider === 'sam3' && !positiveBox) return reply.code(400).send({ error: 'sam3_positive_box_required' });

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE thumbnail_jobs SET status='cancelled',lease_expires_at=NULL,updated_at=now() WHERE thumbnail_project_id=$1 AND status='queued'", [thumbnailId]);
      const project = await client.query(`
        UPDATE thumbnail_projects
        SET frame_seconds=$2,source_headline_card_id=$3,brand_asset_id=$4,segmentation_provider=$5,
          positive_box=$6::jsonb,negative_boxes=$7::jsonb,manifest_json=NULL,source_frame_asset_id=NULL,
          subject_asset_id=NULL,preview_asset_id=NULL,export_asset_id=NULL,status='queued',error=NULL,updated_at=now()
        WHERE id=$1
        RETURNING *
      `, [thumbnailId, frameSeconds, sourceHeadlineCardId, brandAssetId, segmentationProvider, positiveBox ? JSON.stringify(positiveBox) : null, JSON.stringify(negativeBoxes)]);
      const job = await client.query('INSERT INTO thumbnail_jobs(thumbnail_project_id) VALUES($1) RETURNING *', [thumbnailId]);
      await client.query('COMMIT');
      return { project: toThumbnailProject(project.rows[0]), job: toThumbnailJob(job.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/v1/thumbnails/:thumbnailId/export', async (request, reply) => {
    const { thumbnailId } = request.params as { thumbnailId: string };
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const project = await client.query("UPDATE thumbnail_projects SET status='export_queued',error=NULL,updated_at=now() WHERE id=$1 AND status IN ('ready','completed') RETURNING *", [thumbnailId]);
      if (!project.rowCount) {
        const exists = await client.query('SELECT status FROM thumbnail_projects WHERE id=$1', [thumbnailId]);
        await client.query('ROLLBACK');
        return exists.rowCount
          ? reply.code(409).send({ error: 'thumbnail_not_ready', status: exists.rows[0].status })
          : reply.code(404).send({ error: 'thumbnail_not_found' });
      }
      const job = await client.query('INSERT INTO thumbnail_jobs(thumbnail_project_id) VALUES($1) RETURNING *', [thumbnailId]);
      await client.query('COMMIT');
      return reply.code(202).send({ project: toThumbnailProject(project.rows[0]), job: toThumbnailJob(job.rows[0]) });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/v1/candidates/:candidateId/audience', async (request, reply) => {
    const { candidateId } = request.params as { candidateId: string };
    const source = await db.query(`
      SELECT y.id AS video_id, y.youtube_video_id
      FROM clip_candidates c
      JOIN processing_jobs j ON j.id=c.job_id
      JOIN youtube_videos y ON y.media_source_id=j.source_id
      WHERE c.id=$1
      LIMIT 1
    `, [candidateId]);
    if (!source.rowCount) return reply.code(404).send({ error: 'audience_source_not_found' });
    const videoId = source.rows[0].video_id as string;
    const current = await db.query(`
      SELECT s.import_id, s.start_seconds, s.end_seconds, s.signal, s.classifications, s.trend
      FROM youtube_audience_clip_snapshots s
      WHERE s.candidate_id=$1
      ORDER BY s.collected_at DESC
      LIMIT 1
    `, [candidateId]);
    const moments = await db.query(`
      SELECT moment_key, video_id, start_seconds, end_seconds, audience_signal, rewatch_score, retention_score, entry_score, exit_safety_score, confidence, confidence_label, total_segment_impressions, overlap_percentage, covered_by_existing_clip, overlapping_clip_ids, signal, classifications, trend
      FROM youtube_audience_moment_snapshots
      WHERE video_id=$1
        AND collected_at=(SELECT max(latest.collected_at) FROM youtube_audience_moment_snapshots latest WHERE latest.video_id=$1)
      ORDER BY audience_signal DESC, start_seconds
    `, [videoId]);
    const history = await db.query('SELECT audience_signal, collected_at, classifications FROM youtube_audience_clip_snapshots WHERE candidate_id=$1 ORDER BY collected_at', [candidateId]);
    let hydratedSignal = current.rowCount ? current.rows[0].signal : null;
    if (current.rowCount && current.rows[0].import_id) {
      const retention = await db.query<AudienceRetentionRow>(
        `SELECT segment_start_seconds, segment_end_seconds, audience_watch_ratio, started_watching
         FROM youtube_retention_points
         WHERE video_id=$1 AND import_id=$2
         ORDER BY segment_number, segment_start_seconds`,
        [videoId, current.rows[0].import_id],
      );
      hydratedSignal = hydrateAudienceSignal(hydratedSignal, retention.rows, Number(current.rows[0].start_seconds), Number(current.rows[0].end_seconds));
    }
    const signal = current.rowCount ? AudienceSignalSchema.parse({ ...hydratedSignal, classifications: current.rows[0].classifications ?? hydratedSignal?.classifications ?? [], trend: current.rows[0].trend ?? hydratedSignal?.trend ?? null }) : null;
    return {
      videoId,
      youtubeVideoId: source.rows[0].youtube_video_id,
      signal,
      moments: moments.rows.map((row) => AudienceMomentSchema.parse({ ...row.signal, id: row.moment_key, videoId: row.video_id, startSeconds: Number(row.start_seconds), endSeconds: Number(row.end_seconds), audienceSignal: Number(row.audience_signal), rewatchScore: Number(row.rewatch_score), retentionScore: Number(row.retention_score), entryScore: Number(row.entry_score), exitSafetyScore: Number(row.exit_safety_score), confidence: Number(row.confidence), confidenceLabel: row.confidence_label, totalSegmentImpressions: Number(row.total_segment_impressions), overlappingClipIds: row.overlapping_clip_ids ?? [], overlapPercentage: Number(row.overlap_percentage), coveredByExistingClip: row.covered_by_existing_clip, classifications: row.classifications ?? row.signal?.classifications ?? [], trend: row.trend ?? row.signal?.trend ?? null })),
      history: history.rows.map((row) => ({ audienceSignal: Number(row.audience_signal), collectedAt: row.collected_at.toISOString(), classifications: row.classifications ?? [] })),
    };
  });

  app.patch('/v1/candidates/:candidateId', async (request, reply) => {
    const { candidateId } = request.params as { candidateId: string };
    const input = UpdateCandidateSchema.parse(request.body);
    const existing = await db.query('SELECT * FROM clip_candidates WHERE id=$1', [candidateId]);
    if (!existing.rowCount) return reply.code(404).send({ error: 'candidate_not_found' });
    const current = existing.rows[0];
    const startSeconds = input.startSeconds ?? Number(current.edited_start_seconds ?? current.start_seconds);
    const endSeconds = input.endSeconds ?? Number(current.edited_end_seconds ?? current.end_seconds);
    if (endSeconds < startSeconds || endSeconds - startSeconds > 60) return reply.code(400).send({ error: 'invalid_candidate_window', message: 'Clip length must be between 0 and 60 seconds.' });
    const reviewStatus = input.reviewStatus ?? current.review_status;
    const socialCopy = input.socialCopy ?? current.social_copy ?? {};
    const reviewedBy = input.reviewer === undefined ? current.reviewed_by : input.reviewer;
    const notes = input.notes === undefined ? current.notes : input.notes;
    const posted = input.posted ?? current.posted;
    const postedBy = input.postedBy === undefined ? current.posted_by : input.postedBy;
    const updated = await db.query("UPDATE clip_candidates SET edited_start_seconds=$2, edited_end_seconds=$3, review_status=$4, social_copy=$5, reviewed_by=$6, reviewed_at=CASE WHEN $4='proposed' THEN NULL ELSE now() END, notes=$7, posted=$8, posted_by=$9, posted_at=CASE WHEN $8 THEN COALESCE(posted_at, now()) ELSE NULL END WHERE id=$1 RETURNING *", [candidateId, input.startSeconds === undefined && input.endSeconds === undefined ? current.edited_start_seconds : startSeconds, input.startSeconds === undefined && input.endSeconds === undefined ? current.edited_end_seconds : endSeconds, reviewStatus, socialCopy, reviewedBy, notes, posted, postedBy]);
    if (input.reviewStatus || input.reviewer !== undefined || input.notes !== undefined) await db.query('INSERT INTO reviews(candidate_id,status,reviewer,notes) VALUES($1,$2,$3,$4)', [candidateId, reviewStatus, input.reviewer ?? null, input.notes ?? null]);
    return toCandidate(updated.rows[0]);
  });

  app.post('/v1/candidates/:candidateId/renders', async (request, reply) => {
    const { candidateId } = request.params as { candidateId: string };
    const input = CreateRenderSchema.parse(request.body ?? {});
    const candidate = await db.query('SELECT id, COALESCE(edited_start_seconds, start_seconds) AS start_seconds, COALESCE(edited_end_seconds, end_seconds) AS end_seconds FROM clip_candidates WHERE id=$1', [candidateId]);
    if (!candidate.rowCount) return reply.code(404).send({ error: 'candidate_not_found' });
    const candidateStart = Number(candidate.rows[0].start_seconds);
    const candidateEnd = Number(candidate.rows[0].end_seconds);
    if (candidateEnd < candidateStart || candidateEnd - candidateStart > 60) return reply.code(400).send({ error: 'invalid_candidate_window', message: 'Clip length must be between 0 and 60 seconds.' });
    if (input.logoAssetId) {
      const logo = await db.query('SELECT 1 FROM brand_assets WHERE id=$1 AND active=true', [input.logoAssetId]);
      if (!logo.rowCount) return reply.code(400).send({ error: 'brand_asset_not_found' });
    }
    const result = await db.query('INSERT INTO clip_renders(candidate_id,profile,fit_mode,background,logo_position,logo_asset_id,caption_mode,include_logo) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [candidateId, input.profile, input.fitMode, input.background, input.logoPosition, input.logoAssetId, input.captionMode, input.includeLogo]);
    return reply.code(201).send(toRender(result.rows[0]));
  });

  app.get('/v1/candidates/:candidateId/renders', async (request, reply) => {
    const { candidateId } = request.params as { candidateId: string };
    const result = await db.query('SELECT * FROM clip_renders WHERE candidate_id=$1 ORDER BY created_at DESC', [candidateId]);
    if (!result.rowCount) {
      const candidate = await db.query('SELECT 1 FROM clip_candidates WHERE id=$1', [candidateId]);
      if (!candidate.rowCount) return reply.code(404).send({ error: 'candidate_not_found' });
    }
    return { items: result.rows.map(toRender) };
  });

  app.get('/v1/renders/:renderId', async (request, reply) => {
    const { renderId } = request.params as { renderId: string };
    const result = await db.query('SELECT * FROM clip_renders WHERE id=$1', [renderId]);
    return result.rowCount ? toRender(result.rows[0]) : reply.code(404).send({ error: 'render_not_found' });
  });

  app.get('/v1/dashboard/queue', async (request) => {
    const query = request.query as { q?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);
    const rows = await loadDashboardRows(db, null, query.q?.trim() || null, limit);
    return { items: rows.map(toDashboardClip) };
  });

  app.post('/v1/jobs/:jobId/cancel', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const result = await db.query("UPDATE processing_jobs SET status='cancelled', lease_expires_at=NULL WHERE id=$1 AND status IN ('queued','processing') RETURNING *", [jobId]);
    if (result.rowCount) return toJob(result.rows[0]);
    const exists = await db.query('SELECT 1 FROM processing_jobs WHERE id=$1', [jobId]);
    return exists.rowCount ? reply.code(409).send({ error: 'job_not_cancellable' }) : reply.code(404).send({ error: 'job_not_found' });
  });

  app.get('/v1/clips', async () => ({ items: (await db.query('SELECT c.*, r.id AS render_id, r.asset_id FROM clip_candidates c LEFT JOIN clip_renders r ON r.candidate_id=c.id ORDER BY c.created_at DESC')).rows.map(toCandidate) }));
  app.get('/v1/clips/search', async (request) => {
    const query = (request.query as { q?: string }).q ?? '';
    return { items: (await db.query("SELECT c.* FROM clip_candidates c WHERE c.metadata::text ILIKE $1 OR c.social_copy::text ILIKE $1 OR EXISTS (SELECT 1 FROM transcripts t WHERE t.job_id=c.job_id AND t.full_text ILIKE $1) OR EXISTS (SELECT 1 FROM transcripts t JOIN transcript_segments s ON s.transcript_id=t.id WHERE t.job_id=c.job_id AND s.text ILIKE $1) ORDER BY c.created_at DESC", [`%${query}%`])).rows.map(toCandidate) };
  });

  app.get('/v1/clips/:candidateId', async (request, reply) => {
    const { candidateId } = request.params as { candidateId: string };
    const rows = await loadDashboardRows(db, candidateId, null, 1);
    return rows.length ? toDashboardClip(rows[0]) : reply.code(404).send({ error: 'clip_not_found' });
  });

  app.patch('/v1/clips/:candidateId', async (request, reply) => {
    const { candidateId } = request.params as { candidateId: string };
    const input = UpdateCandidateSchema.parse(request.body);
    const existing = await db.query('SELECT * FROM clip_candidates WHERE id=$1', [candidateId]);
    if (!existing.rowCount) return reply.code(404).send({ error: 'clip_not_found' });
    const current = existing.rows[0];
    const startSeconds = input.startSeconds ?? Number(current.edited_start_seconds ?? current.start_seconds);
    const endSeconds = input.endSeconds ?? Number(current.edited_end_seconds ?? current.end_seconds);
    if (endSeconds < startSeconds || endSeconds - startSeconds > 60) return reply.code(400).send({ error: 'invalid_clip_window', message: 'Clip length must be between 0 and 60 seconds.' });
    const reviewStatus = input.reviewStatus ?? current.review_status;
    const socialCopy = input.socialCopy ?? current.social_copy ?? {};
    const notes = input.notes === undefined ? current.notes : input.notes;
    const posted = input.posted ?? current.posted;
    const postedBy = input.postedBy === undefined ? current.posted_by : input.postedBy;
    const updated = await db.query("UPDATE clip_candidates SET edited_start_seconds=$2, edited_end_seconds=$3, review_status=$4, social_copy=$5, notes=$6, posted=$7, posted_by=$8, posted_at=CASE WHEN $7 THEN COALESCE(posted_at, now()) ELSE NULL END WHERE id=$1 RETURNING *", [candidateId, startSeconds, endSeconds, reviewStatus, socialCopy, notes, posted, postedBy]);
    return toDashboardClip((await loadDashboardRows(db, candidateId, null, 1))[0] ?? updated.rows[0]);
  });

  app.get('/v1/assets/:assetId', async (request, reply) => {
    const { assetId } = request.params as { assetId: string };
    const result = await db.query('SELECT storage_key,content_type,byte_size FROM assets WHERE id=$1', [assetId]);
    if (!result.rowCount) return reply.code(404).send({ error: 'asset_not_found' });
    const asset = result.rows[0];
    try {
      const knownSize = Number(asset.byte_size);
      const hasKnownSize = Number.isSafeInteger(knownSize) && knownSize >= 0;
      const full = hasKnownSize ? null : await store.getStream(asset.storage_key);
      const fileSize = hasKnownSize ? knownSize : full!.totalLength;
      if (!Number.isSafeInteger(fileSize) || fileSize < 0) return reply.code(404).send({ error: 'asset_not_found' });
      reply.header('Content-Type', asset.content_type ?? 'application/octet-stream');
      reply.header('Content-Disposition', 'inline');
      reply.header('Accept-Ranges', 'bytes');
      const rangeHeader = request.headers.range;
      if (!rangeHeader) {
        reply.header('Content-Length', String(fileSize));
        return reply.send(full ? full.stream : (await store.getStream(asset.storage_key)).stream);
      }

      const range = parseByteRange(rangeHeader, fileSize);
      if (!range) {
        reply.header('Content-Range', `bytes */${fileSize}`);
        return reply.code(416).send();
      }
      const ranged = await store.getStream(asset.storage_key, range);
      reply.code(206);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${fileSize}`);
      reply.header('Content-Length', String(ranged.contentLength));
      return reply.send(ranged.stream);
    } catch {
      return reply.code(404).send({ error: 'asset_not_found' });
    }
  });
  return app;
}

function parseByteRange(value: string, fileSize: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || fileSize <= 0) return null;
  const requestedStart = match[1] ? Number(match[1]) : null;
  const requestedEnd = match[2] ? Number(match[2]) : null;
  const start = requestedStart === null ? Math.max(0, fileSize - (requestedEnd ?? 0)) : requestedStart;
  const end = requestedEnd === null ? fileSize - 1 : Math.min(requestedEnd, fileSize - 1);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < fileSize && end >= start ? { start, end } : null;
}
