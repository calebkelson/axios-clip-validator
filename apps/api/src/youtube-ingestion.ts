import pg from 'pg';

export type YouTubeIngestMode = 'whole_media' | 'find_moments' | 'transcribe_only';

export type YouTubeIngestItem = {
  id: string;
  youtubeVideoId: string;
  title: string;
  sourceId: string;
  mode: YouTubeIngestMode;
  jobId: string | null;
  status: 'dry_run' | 'queued' | 'already_queued';
};

export type YouTubeIngestResult = {
  dryRun: boolean;
  mode: YouTubeIngestMode;
  selected: number;
  queued: number;
  items: YouTubeIngestItem[];
};

type IngestRow = {
  id: string;
  youtube_video_id: string;
  title: string;
  media_source_id: string;
};

export class YouTubeIngestionService {
  constructor(private readonly db: pg.Pool) {}

  async enqueue(options: {
    channelId?: string;
    videoIds?: string[];
    limit?: number;
    mode?: YouTubeIngestMode;
    dryRun?: boolean;
  } = {}): Promise<YouTubeIngestResult> {
    const limit = options.limit ?? 5;
    const mode = options.mode ?? 'find_moments';
    const dryRun = options.dryRun ?? false;
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const rows = await this.selectDiscovered(client, options.channelId, options.videoIds, limit, !dryRun);
      const items: YouTubeIngestItem[] = [];
      for (const row of rows) {
        if (dryRun) {
          items.push({ id: row.id, youtubeVideoId: row.youtube_video_id, title: row.title, sourceId: row.media_source_id, mode, jobId: null, status: 'dry_run' });
          continue;
        }
        const idempotencyKey = `youtube-ingest:${row.id}:${mode}`;
        const job = await client.query<{ id: string; status: string }>(`
          INSERT INTO processing_jobs(source_id,mode,idempotency_key,raw_provider_payload)
          VALUES($1,$2,$3,$4::jsonb)
          ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
          RETURNING id,status
        `, [row.media_source_id, mode, idempotencyKey, JSON.stringify({ source: 'youtube-catalog', youtubeVideoId: row.youtube_video_id, youtubeVideoRowId: row.id })]);
        const jobRow = job.rows[0];
        await client.query(`
          UPDATE youtube_videos
          SET ingestion_status='queued', ingestion_job_id=$2, ingestion_requested_at=COALESCE(ingestion_requested_at,now()), ingestion_error=NULL, updated_at=now()
          WHERE id=$1
        `, [row.id, jobRow.id]);
        items.push({ id: row.id, youtubeVideoId: row.youtube_video_id, title: row.title, sourceId: row.media_source_id, mode, jobId: jobRow.id, status: 'queued' });
      }
      await client.query('COMMIT');
      return { dryRun, mode, selected: items.length, queued: dryRun ? 0 : items.length, items };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async selectDiscovered(client: pg.PoolClient, channelId: string | undefined, videoIds: string[] | undefined, limit: number, lock: boolean) {
    const values: unknown[] = [];
    const where = [
      "v.ingestion_status='discovered'",
      'v.ingestion_job_id IS NULL',
      "COALESCE(v.availability, 'public') = 'public'",
      "COALESCE(v.live_status, 'none') NOT IN ('live', 'upcoming')",
      "s.provider='youtube'",
    ];
    if (channelId?.trim()) {
      values.push(channelId.trim());
      where.push(`(ch.youtube_channel_id=$${values.length} OR ch.id::text=$${values.length})`);
    }
    if (videoIds?.length) {
      values.push(videoIds);
      where.push(`(v.youtube_video_id = ANY($${values.length}::text[]) OR v.id::text = ANY($${values.length}::text[]))`);
    }
    values.push(limit);
    const lockClause = lock ? 'FOR UPDATE OF v SKIP LOCKED' : '';
    const result = await client.query<IngestRow>(`
      SELECT v.id,v.youtube_video_id,v.title,v.media_source_id
      FROM youtube_videos v
      JOIN media_sources s ON s.id=v.media_source_id
      LEFT JOIN youtube_channels ch ON ch.id=v.channel_id
      WHERE ${where.join(' AND ')}
      ORDER BY v.published_at DESC NULLS LAST, v.created_at DESC
      LIMIT $${values.length}
      ${lockClause}
    `, values);
    return result.rows;
  }
}
