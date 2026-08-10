import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import {
  AUDIENCE_SIGNAL_CONFIG,
  buildAudienceTrend,
  classifyAudienceSignal,
  detectAudienceMoments,
  scoreClipWindow,
  scoreRetentionDataset,
  selectPrimaryAudienceClassification,
  type AudienceHistoryPoint,
  type RetentionPoint,
} from '../packages/processing/src/audience-signals/index.js';

const connectionString = process.env.DATABASE_URL ?? 'postgres://clipper:clipper@127.0.0.1:5433/clipper';
const defaultCsv = '/Users/calebkelson/Documents/Clipping Automation/data/youtube-retention/youtube_retention_all_133_videos.csv';
const csvPath = resolve(process.env.YOUTUBE_RETENTION_CSV ?? defaultCsv);
const force = process.argv.includes('--force');

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (character === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    if (row.some((value) => value !== '')) rows.push(row);
  }
  const headers = rows.shift() ?? [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function number(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function retentionPoint(row: Record<string, string>): RetentionPoint {
  return {
    videoId: row.video_id,
    videoTitle: row.video_title || null,
    videoDurationSeconds: number(row.video_duration_seconds) || null,
    segmentNumber: Math.max(1, Math.trunc(number(row.segment_number))),
    elapsedVideoTimeRatio: number(row.elapsedVideoTimeRatio),
    segmentStartSeconds: number(row.segment_start_seconds),
    segmentEndSeconds: number(row.segment_end_seconds),
    audienceWatchRatio: number(row.audienceWatchRatio),
    startedWatching: number(row.startedWatching),
    stoppedWatching: number(row.stoppedWatching),
    totalSegmentImpressions: number(row.totalSegmentImpressions),
    relativeRetentionPerformance: number(row.relativeRetentionPerformance),
    queryStartDate: row.query_start_date || null,
    queryEndDate: row.query_end_date || null,
  };
}

function asJson(value: unknown) {
  return JSON.stringify(value ?? {});
}

type VideoRow = { id: string; youtube_video_id: string };
type ClipRow = { id: string; video_id: string; youtube_video_id: string; startSeconds: number; endSeconds: number };
type DatabaseClipRow = { id: string; video_id: string; youtube_video_id: string; start_seconds: string | number; end_seconds: string | number };

async function main() {
  const file = await readFile(csvPath, 'utf8');
  const digest = createHash('sha256').update(file).digest('hex');
  const rows = parseCsv(file).map(retentionPoint).filter((point) => point.videoId && point.segmentEndSeconds >= point.segmentStartSeconds);
  if (!rows.length) throw new Error(`No retention rows found in ${csvPath}`);
  const groups = new Map<string, RetentionPoint[]>();
  for (const row of rows) groups.set(row.videoId, [...(groups.get(row.videoId) ?? []), row]);

  const db = new pg.Pool({ connectionString });
  const client = await db.connect();
  try {
    const existing = await client.query<{ id: string }>('SELECT id FROM youtube_retention_imports WHERE source_hash=$1 LIMIT 1', [digest]);
    if (existing.rowCount && !force) {
      console.log(`Retention dataset already imported (${digest.slice(0, 12)}); use --force to rescore it.`);
      return;
    }
    const videoIds = [...groups.keys()];
    const videos = (await client.query<VideoRow>('SELECT id,youtube_video_id FROM youtube_videos WHERE youtube_video_id=ANY($1::text[])', [videoIds])).rows;
    const videoDbByYoutubeId = new Map(videos.map((video) => [video.youtube_video_id, video]));
    const mappedGroups = new Map([...groups.entries()].filter(([videoId]) => videoDbByYoutubeId.has(videoId)));
    const mappedVideoDbIds = [...mappedGroups.keys()].map((videoId) => videoDbByYoutubeId.get(videoId)!.id);
    if (!mappedGroups.size) throw new Error('No retention video IDs matched youtube_videos in the local database. Run the YouTube catalog backfill first.');

    const collectedAt = new Date();
    const queryStartDate = rows.find((row) => row.queryStartDate)?.queryStartDate ?? null;
    const queryEndDate = rows.find((row) => row.queryEndDate)?.queryEndDate ?? null;
    const sourceHash = force ? `${digest}:${collectedAt.toISOString()}` : digest;
    await client.query('BEGIN');
    try {
      const importResult = await client.query<{ id: string }>(
        'INSERT INTO youtube_retention_imports(source_path,source_hash,query_start_date,query_end_date,video_count,row_count,summary,collected_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id',
        [csvPath, sourceHash, queryStartDate, queryEndDate, mappedGroups.size, rows.length, asJson({ sourceHash: digest, sourceVideoCount: groups.size, mappedVideoCount: mappedGroups.size }), collectedAt],
      );
      const importId = importResult.rows[0].id;
      for (const [youtubeVideoId, points] of mappedGroups) {
        const videoId = videoDbByYoutubeId.get(youtubeVideoId)!.id;
        for (const point of points) {
          await client.query(
            `INSERT INTO youtube_retention_points(import_id,video_id,segment_number,elapsed_video_time_ratio,segment_start_seconds,segment_end_seconds,audience_watch_ratio,started_watching,stopped_watching,total_segment_impressions,relative_retention_performance,query_start_date,query_end_date,raw_provider_payload)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
            [importId, videoId, point.segmentNumber, point.elapsedVideoTimeRatio, point.segmentStartSeconds, point.segmentEndSeconds, point.audienceWatchRatio, point.startedWatching, point.stoppedWatching, point.totalSegmentImpressions, point.relativeRetentionPerformance, point.queryStartDate, point.queryEndDate, asJson(point)],
          );
        }
      }

      const previousMoments = await client.query<{ video_id: string; moment_key: string; audience_signal: number; collected_at: Date; classifications: string[] | null }>(
        'SELECT video_id,moment_key,audience_signal,collected_at,classifications FROM youtube_audience_moment_snapshots WHERE video_id=ANY($1::uuid[]) ORDER BY collected_at',
        [mappedVideoDbIds],
      );
      const previousMomentHistory = new Map<string, AudienceHistoryPoint[]>();
      for (const row of previousMoments.rows) {
        const key = `${row.video_id}:${row.moment_key}`;
        previousMomentHistory.set(key, [...(previousMomentHistory.get(key) ?? []), { audienceSignal: Number(row.audience_signal), collectedAt: row.collected_at.toISOString(), classifications: row.classifications }]);
      }
      const previousClipRows = await client.query<{ candidate_id: string; audience_signal: number; collected_at: Date; classifications: string[] | null }>(
        'SELECT candidate_id,audience_signal,collected_at,classifications FROM youtube_audience_clip_snapshots WHERE video_id=ANY($1::uuid[]) ORDER BY collected_at',
        [mappedVideoDbIds],
      );
      const previousClipHistory = new Map<string, AudienceHistoryPoint[]>();
      for (const row of previousClipRows.rows) previousClipHistory.set(row.candidate_id, [...(previousClipHistory.get(row.candidate_id) ?? []), { audienceSignal: Number(row.audience_signal), collectedAt: row.collected_at.toISOString(), classifications: row.classifications }]);

      const clipRows = (await client.query<DatabaseClipRow>(
        `SELECT c.id,y.id AS video_id,y.youtube_video_id,COALESCE(c.edited_start_seconds,c.start_seconds) AS start_seconds,COALESCE(c.edited_end_seconds,c.end_seconds) AS end_seconds
         FROM clip_candidates c JOIN processing_jobs j ON j.id=c.job_id JOIN youtube_videos y ON y.media_source_id=j.source_id
         WHERE y.youtube_video_id=ANY($1::text[])`,
        [videoIds],
      )).rows.map((clip) => ({ id: clip.id, video_id: clip.video_id, youtube_video_id: clip.youtube_video_id, startSeconds: Number(clip.start_seconds), endSeconds: Number(clip.end_seconds) }));
      const clipsByVideo = new Map<string, ClipRow[]>();
      for (const clip of clipRows) clipsByVideo.set(clip.youtube_video_id, [...(clipsByVideo.get(clip.youtube_video_id) ?? []), clip]);
      const scored = scoreRetentionDataset(mappedGroups, AUDIENCE_SIGNAL_CONFIG);
      let momentCount = 0;
      let clipCount = 0;
      for (const [youtubeVideoId, points] of scored) {
        const videoId = videoDbByYoutubeId.get(youtubeVideoId)!.id;
        const existingClips = clipsByVideo.get(youtubeVideoId) ?? [];
        const moments = detectAudienceMoments(videoId, points, existingClips, { collectedAt: collectedAt.toISOString(), config: AUDIENCE_SIGNAL_CONFIG });
        for (const moment of moments) {
          const history = previousMomentHistory.get(`${videoId}:${moment.id}`) ?? [];
          const trend = buildAudienceTrend(moment, collectedAt.toISOString(), history);
          moment.trend = trend;
          moment.classifications = classifyAudienceSignal(moment, { coveredByExistingClip: moment.coveredByExistingClip, trend, config: AUDIENCE_SIGNAL_CONFIG });
          moment.primaryClassification = selectPrimaryAudienceClassification(moment, AUDIENCE_SIGNAL_CONFIG);
          await client.query(
            `INSERT INTO youtube_audience_moment_snapshots(import_id,video_id,moment_key,start_seconds,end_seconds,audience_signal,rewatch_score,retention_score,entry_score,exit_safety_score,confidence,confidence_label,total_segment_impressions,overlap_percentage,covered_by_existing_clip,overlapping_clip_ids,signal,classifications,trend,collected_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20)`,
            [importId, videoId, moment.id, moment.startSeconds, moment.endSeconds, moment.audienceSignal, moment.rewatchScore, moment.retentionScore, moment.entryScore, moment.exitSafetyScore, moment.confidence, moment.confidenceLabel, moment.totalSegmentImpressions, moment.overlapPercentage, moment.coveredByExistingClip, asJson(moment.overlappingClipIds), asJson(moment), asJson(moment.classifications), asJson(moment.trend), collectedAt],
          );
          momentCount += 1;
        }
        for (const clip of existingClips) {
          const signal = scoreClipWindow(points, clip.startSeconds, clip.endSeconds, AUDIENCE_SIGNAL_CONFIG);
          if (!signal) continue;
          const history = previousClipHistory.get(clip.id) ?? [];
          const trend = buildAudienceTrend(signal, collectedAt.toISOString(), history);
          signal.trend = trend;
          signal.classifications = classifyAudienceSignal(signal, { coveredByExistingClip: true, trend, config: AUDIENCE_SIGNAL_CONFIG });
          signal.primaryClassification = selectPrimaryAudienceClassification(signal, AUDIENCE_SIGNAL_CONFIG);
          await client.query(
            `INSERT INTO youtube_audience_clip_snapshots(import_id,candidate_id,video_id,start_seconds,end_seconds,audience_signal,rewatch_score,retention_score,entry_score,exit_safety_score,confidence,confidence_label,total_segment_impressions,signal,classifications,trend,collected_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17)`,
            [importId, clip.id, videoId, clip.startSeconds, clip.endSeconds, signal.audienceSignal, signal.rewatchScore, signal.retentionScore, signal.entryScore, signal.exitSafetyScore, signal.confidence, signal.confidenceLabel, signal.totalSegmentImpressions, asJson(signal), asJson(signal.classifications), asJson(signal.trend), collectedAt],
          );
          clipCount += 1;
        }
      }
      await client.query('UPDATE youtube_retention_imports SET summary=$2::jsonb WHERE id=$1', [importId, asJson({ sourceHash: digest, sourceVideoCount: groups.size, mappedVideoCount: mappedGroups.size, rowCount: rows.length, momentCount, clipCount })]);
      await client.query('COMMIT');
      console.log(JSON.stringify({ importId, sourceVideos: groups.size, mappedVideos: mappedGroups.size, unmatchedVideos: groups.size - mappedGroups.size, retentionRows: rows.length, audienceMoments: momentCount, clipSignals: clipCount, collectedAt: collectedAt.toISOString() }, null, 2));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
