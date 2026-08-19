import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { promisify } from 'node:util';
import pg from 'pg';
import { AssetStore } from '@clipper/storage';
import { CandidateProposal, EditorialCandidateProvider, createEditorialCandidateProvider } from './candidates.js';
import { createPlatformSourceAdapter, PlatformSourceAdapter } from './source-adapters.js';
export { RenderProcessor, buildAss, buildSrt, formatSrtTime, renderProfiles } from './rendering.js';
export { ThumbnailProcessor, Sam3SidecarClient, Sam3UnavailableError, U2NetpSegmentationProvider, buildExactFrameExtractionArgs, createThumbnailManifest, segmentThumbnail } from './thumbnailing.js';
export type { ThumbnailBox, ThumbnailCommandRunner, ThumbnailSegmentationInput, ThumbnailSegmentationProvider } from './thumbnailing.js';
export { createPlatformSourceAdapter, PlatformSourceAdapter, YtDlpSourceAdapter } from './source-adapters.js';
export * from './audience-signals/index.js';

const execFile = promisify(execFileCallback);

export interface TranscriptSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface TranscriptResult {
  provider: string;
  language: string | null;
  durationSeconds: number | null;
  segments: TranscriptSegment[];
}

export interface TranscriptionProvider {
  transcribe(input: { mediaPath: string; workDir: string }): Promise<TranscriptResult>;
}

/** Remove transcript-only HTML arrows and normalize the whitespace they leave behind. */
export function sanitizeTranscriptText(value: string): string {
  return value.replace(/(?:&gt;|>)\s*(?:&gt;|>)/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function parseProbeJson(raw: string) {
  const probe = JSON.parse(raw) as {
    format?: { duration?: string; size?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string }>;
  };
  const streams = probe.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const frameRate = video?.r_frame_rate ? parseRate(video.r_frame_rate) : null;
  return {
    probe,
    durationSeconds: numberOrNull(probe.format?.duration),
    byteSize: integerOrNull(probe.format?.size),
    width: integerOrNull(video?.width),
    height: integerOrNull(video?.height),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    frameRate,
  };
}

export function parseTranscriptJson(raw: string, provider = 'sidecar'): TranscriptResult {
  const parsed = JSON.parse(raw) as {
    language?: unknown;
    durationSeconds?: unknown;
    duration?: unknown;
    segments?: unknown;
  };
  if (!Array.isArray(parsed.segments)) throw new Error('Transcript JSON must contain a segments array');
  const segments = parsed.segments.map((segment, index) => {
    if (!segment || typeof segment !== 'object') throw new Error(`Transcript segment ${index} is invalid`);
    const value = segment as Record<string, unknown>;
    const start = numberOrNull(value.startSeconds ?? value.start);
    const end = numberOrNull(value.endSeconds ?? value.end);
    const originalText = typeof value.text === 'string' ? value.text.trim() : '';
    const text = sanitizeTranscriptText(originalText);
    if (start === null || end === null || end < start || !originalText) throw new Error(`Transcript segment ${index} is invalid`);
    if (!text) return null;
    return { startSeconds: start, endSeconds: end, text };
  }).filter((segment): segment is TranscriptSegment => segment !== null);
  return {
    provider,
    language: typeof parsed.language === 'string' ? parsed.language : null,
    durationSeconds: numberOrNull(parsed.durationSeconds ?? parsed.duration),
    segments,
  };
}

export function parseVttTranscript(raw: string, provider = 'vtt-sidecar'): TranscriptResult {
  const lines = raw.replaceAll('\r', '').split('\n');
  const timingPattern = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})/;
  const cues: Array<{ startSeconds: number; endSeconds: number; textLines: string[] }> = [];
  let current: { startSeconds: number; endSeconds: number; textLines: string[] } | null = null;
  const flush = () => {
    if (current) cues.push(current);
    current = null;
  };
  for (const line of lines) {
    const match = line.trim().match(timingPattern);
    if (match) {
      flush();
      current = { startSeconds: vttTimeToSeconds(match[1]), endSeconds: vttTimeToSeconds(match[2]), textLines: [] };
    } else if (current) {
      current.textLines.push(line);
    }
  }
  flush();

  const segments: TranscriptSegment[] = [];
  for (const cue of cues) {
    if (cue.endSeconds - cue.startSeconds < 0.05) continue;
    const rawText = sanitizeTranscriptText(cue.textLines.join(' ').replace(/<[^>]*>/g, ' '));
    if (!rawText) continue;
    const previous = segments.at(-1);
    const overlap = previous ? vttWordOverlap(previous.text, rawText) : 0;
    const text = sanitizeTranscriptText(overlap >= 3 ? rawText.split(/\s+/).slice(overlap).join(' ') : rawText);
    if (!text) continue;
    segments.push({ startSeconds: cue.startSeconds, endSeconds: cue.endSeconds, text });
  }

  return {
    provider,
    language: 'en',
    durationSeconds: segments.at(-1)?.endSeconds ?? null,
    segments,
  };
}

function vttTimeToSeconds(value: string) {
  const [hours, minutes, seconds] = value.split(':');
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function vttWordOverlap(previousText: string, currentText: string) {
  const previous = previousText.toLowerCase().replace(/[^a-z0-9%?'’-]+/g, ' ').split(/\s+/).filter(Boolean);
  const current = currentText.toLowerCase().replace(/[^a-z0-9%?'’-]+/g, ' ').split(/\s+/).filter(Boolean);
  const maximum = Math.min(12, previous.length, current.length);
  for (let size = maximum; size >= 3; size -= 1) {
    const previousTail = previous.slice(-size);
    const currentHead = current.slice(0, size);
    if (previousTail.every((word, index) => word === currentHead[index])) return size;
  }
  return 0;
}

export class SidecarTranscriptionProvider implements TranscriptionProvider {
  async transcribe({ mediaPath }: { mediaPath: string; workDir: string }) {
    const extension = extname(mediaPath);
    const mediaBase = extension ? mediaPath.slice(0, -extension.length) : mediaPath;
    const candidates = [
      `${mediaPath}.transcript.json`,
      ...(extension ? [join(mediaBase, 'transcript.json')] : []),
      `${mediaBase}.en-orig.vtt`,
      `${mediaBase}.en.vtt`,
      `${mediaBase}.vtt`,
    ];
    for (const candidate of candidates) {
      try {
        const raw = await readFile(candidate, 'utf8');
        return candidate.endsWith('.vtt') ? parseVttTranscript(raw) : parseTranscriptJson(raw);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    throw new Error(`No transcript sidecar found for ${basename(mediaPath)}; expected ${basename(candidates[0])}`);
  }
}

export class WhisperCliTranscriptionProvider implements TranscriptionProvider {
  constructor(private readonly binary = 'whisper', private readonly model = 'base', private readonly language?: string) {}

  async transcribe({ mediaPath, workDir }: { mediaPath: string; workDir: string }) {
    await mkdir(workDir, { recursive: true });
    const args = [mediaPath, '--model', this.model, '--output_format', 'json', '--output_dir', workDir];
    if (this.language) args.push('--language', this.language);
    await runCommand(this.binary, args);
    const outputPath = join(workDir, `${basename(mediaPath, extname(mediaPath))}.json`);
    const result = parseTranscriptJson(await readFile(outputPath, 'utf8'), 'whisper-cli');
    await rm(outputPath, { force: true });
    return result;
  }
}

export function createTranscriptionProvider(env: NodeJS.ProcessEnv = process.env): TranscriptionProvider {
  if (env.TRANSCRIPTION_PROVIDER === 'whisper') {
    return new WhisperCliTranscriptionProvider(env.WHISPER_BIN ?? 'whisper', env.WHISPER_MODEL ?? 'base', env.WHISPER_LANGUAGE);
  }
  return new SidecarTranscriptionProvider();
}

export class MediaProcessor {
  private readonly transcriber: TranscriptionProvider;
  private readonly candidateProvider: EditorialCandidateProvider;
  private readonly ffprobeBinary: string;
  private readonly maxSourceBytes: number;

  constructor(
    private readonly db: pg.Pool,
    private readonly store: AssetStore,
    private readonly leaseSeconds = 60,
    options: { transcriber?: TranscriptionProvider; candidateProvider?: EditorialCandidateProvider; ffprobeBinary?: string; maxSourceBytes?: number; platformSourceAdapter?: PlatformSourceAdapter | null } = {},
  ) {
    this.transcriber = options.transcriber ?? createTranscriptionProvider();
    this.candidateProvider = options.candidateProvider ?? createEditorialCandidateProvider();
    this.ffprobeBinary = options.ffprobeBinary ?? process.env.FFPROBE_BIN ?? 'ffprobe';
    this.maxSourceBytes = options.maxSourceBytes ?? Number(process.env.MAX_SOURCE_BYTES ?? 5_000_000_000);
    this.platformSourceAdapter = options.platformSourceAdapter === undefined ? createPlatformSourceAdapter() : options.platformSourceAdapter;
  }

  private readonly platformSourceAdapter: PlatformSourceAdapter | null;

  async recoverExpired() {
    return (await this.db.query("UPDATE processing_jobs SET status='queued', claimed_at=NULL, lease_expires_at=NULL WHERE status='processing' AND lease_expires_at < now() RETURNING id")).rowCount ?? 0;
  }

  async runOnce() {
    await this.recoverExpired();
    const claim = await this.db.query("WITH selected_job AS (SELECT id FROM processing_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE processing_jobs AS j SET status='processing', attempts=j.attempts+1, claimed_at=now(), lease_expires_at=now() + ($1 * interval '1 second'), progress=5 FROM selected_job AS s WHERE j.id=s.id RETURNING j.id, j.source_id, j.mode", [this.leaseSeconds]);
    if (!claim.rowCount) return null;
    const job = claim.rows[0] as { id: string; source_id: string; mode: string };
    let youtubeSourceId: string | null = null;
    const mediaWorkDir = join(process.env.TMPDIR ?? '/tmp', 'clipper-media', job.id);

    try {
      const sourceResult = await this.db.query('SELECT * FROM media_sources WHERE id=$1', [job.source_id]);
      if (!sourceResult.rowCount) throw new Error(`Source ${job.source_id} was not found`);
      const source = sourceResult.rows[0] as { id: string; source_type: string; media_type: 'video' | 'audio'; uri: string; provider: string | null };
      youtubeSourceId = source.provider === 'youtube' ? source.id : null;
      if (youtubeSourceId) await this.updateYouTubeIngestion(youtubeSourceId, 'downloading');

      await this.updateProgress(job.id, 15);
      const sourceAsset = await this.ensureSourceAsset(source, job.id);
      const sourcePath = await this.store.materialize(sourceAsset.storageKey, mediaWorkDir);
      if (youtubeSourceId) await this.updateYouTubeIngestion(youtubeSourceId, 'asset_registered');
      await this.updateProgress(job.id, 45);
      const probe = await this.probeSource(source.id, sourcePath, sourceAsset.contentType, sourceAsset.byteSize);
      await this.updateProgress(job.id, 70);

      const result: Record<string, unknown> = {
        sourceAssetId: sourceAsset.assetId,
        probe: { sourceId: source.id, durationSeconds: probe.durationSeconds, width: probe.width, height: probe.height },
      };
      if (job.mode === 'transcribe_only' || job.mode === 'find_moments') {
        if (youtubeSourceId) await this.updateYouTubeIngestion(youtubeSourceId, 'processing');
        const transcript = await this.transcribe(job.id, source.id, sourcePath, probe.durationSeconds);
        result.transcriptId = transcript.id;
        if (job.mode === 'find_moments') {
          const candidateCount = await this.persistCandidates(job.id, transcript.id, transcript.segments, probe.durationSeconds);
          result.candidateCount = candidateCount;
          result.candidateProvider = this.candidateProvider.name;
          result.nextStep = 'producer_review';
        }
      }

      await this.db.query("UPDATE processing_jobs SET status='completed', progress=100, completed_at=now(), lease_expires_at=NULL, result=$2 WHERE id=$1", [job.id, result]);
      if (youtubeSourceId) await this.updateYouTubeIngestion(youtubeSourceId, 'ready');
      return job.id;
    } catch (error) {
      await this.db.query("UPDATE processing_jobs SET status='failed', last_error=$2, lease_expires_at=NULL WHERE id=$1", [job.id, error instanceof Error ? error.message : 'media processing failure']);
      if (youtubeSourceId) {
        try {
          await this.updateYouTubeIngestion(youtubeSourceId, 'failed', error instanceof Error ? error.message : 'media processing failure');
        } catch {
          // Preserve the original processing error if the catalog status update fails.
        }
      }
      throw error;
    } finally {
      await rm(mediaWorkDir, { recursive: true, force: true });
    }
  }

  private async updateYouTubeIngestion(sourceId: string, status: 'downloading' | 'asset_registered' | 'processing' | 'ready' | 'failed', error: string | null = null) {
    await this.db.query('UPDATE youtube_videos SET ingestion_status=$2, ingestion_error=$3, updated_at=now() WHERE media_source_id=$1', [sourceId, status, error?.slice(0, 4000) ?? null]);
  }

  private async updateProgress(jobId: string, progress: number) {
    await this.db.query('UPDATE processing_jobs SET progress=$2 WHERE id=$1', [jobId, progress]);
  }

  private async ensureSourceAsset(source: { id: string; source_type: string; uri: string; provider: string | null; media_type: 'video' | 'audio' }, jobId: string) {
    const existing = await this.db.query("SELECT id, storage_key, content_type, byte_size FROM assets WHERE source_id=$1 AND role='source' ORDER BY created_at DESC LIMIT 1", [source.id]);
    if (existing.rowCount) {
      const asset = existing.rows[0];
      return { assetId: asset.id as string, storageKey: asset.storage_key as string, contentType: asset.content_type as string | null, byteSize: asset.byte_size as number | null };
    }
    if (source.source_type === 'upload') throw new Error(`Uploaded source ${source.id} has no stored asset`);
    if (source.source_type === 'platform_url') {
      if (!source.provider) throw new Error('Platform source is missing a provider');
      if (!this.platformSourceAdapter) throw new Error(`No platform adapter configured for ${source.provider}`);
      const workDir = join(process.env.TMPDIR ?? '/tmp', 'clipper-source-adapters', jobId);
      await mkdir(workDir, { recursive: true });
      try {
        const downloaded = await this.platformSourceAdapter.download({ uri: source.uri, provider: source.provider, mediaType: source.media_type }, workDir, this.maxSourceBytes);
        const key = `sources/${source.id}/original`;
        const stored = await this.store.putStream(key, createReadStream(downloaded.path));
        const asset = await this.db.query("INSERT INTO assets(source_id, storage_key, role, content_type, byte_size, public_reference, metadata) VALUES($1,$2,'source',$3,$4,$5,$6) ON CONFLICT(storage_key) DO UPDATE SET byte_size=EXCLUDED.byte_size, content_type=EXCLUDED.content_type, metadata=EXCLUDED.metadata RETURNING id, storage_key, content_type, byte_size", [source.id, key, downloaded.contentType, stored.byteSize, this.store.getPublicReference(key), { adapter: this.platformSourceAdapter.name, provider: source.provider }]);
        return { assetId: asset.rows[0].id as string, storageKey: key, contentType: downloaded.contentType, byteSize: stored.byteSize };
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    }

    const response = await fetch(source.uri);
    if (!response.ok || !response.body) throw new Error(`Source download failed with HTTP ${response.status}`);
    const contentType = response.headers.get('content-type');
    const contentLength = integerOrNull(response.headers.get('content-length'));
    if (contentLength !== null && contentLength > this.maxSourceBytes) throw new Error(`Source exceeds MAX_SOURCE_BYTES (${this.maxSourceBytes})`);
    const key = `sources/${source.id}/original`;
    const limited = new ByteLimitTransform(this.maxSourceBytes);
    let result: { key: string; byteSize: number };
    try {
      result = await this.store.putStream(key, Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(limited));
    } catch (error) {
      await this.store.delete(key);
      throw error;
    }
    const asset = await this.db.query("INSERT INTO assets(source_id, storage_key, role, content_type, byte_size, public_reference) VALUES($1,$2,'source',$3,$4,$5) ON CONFLICT(storage_key) DO UPDATE SET byte_size=EXCLUDED.byte_size RETURNING id, storage_key, content_type, byte_size", [source.id, key, contentType, result.byteSize, this.store.getPublicReference(key)]);
    return { assetId: asset.rows[0].id as string, storageKey: key, contentType, byteSize: result.byteSize };
  }

  private async probeSource(sourceId: string, path: string, contentType: string | null, byteSize: number | null) {
    await this.db.query("INSERT INTO source_probes(source_id,status,content_type,byte_size,updated_at) VALUES($1,'processing',$2,$3,now()) ON CONFLICT(source_id) DO UPDATE SET status='processing', error=NULL, content_type=EXCLUDED.content_type, byte_size=EXCLUDED.byte_size, updated_at=now()", [sourceId, contentType, byteSize]);
    try {
      const { stdout } = await execFile(this.ffprobeBinary, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { maxBuffer: 4 * 1024 * 1024 });
      const parsed = parseProbeJson(stdout);
      await this.db.query("UPDATE source_probes SET status='completed', content_type=$2, byte_size=COALESCE($3, byte_size), duration_seconds=$4, width=$5, height=$6, video_codec=$7, audio_codec=$8, frame_rate=$9, probe_json=$10, error=NULL, updated_at=now() WHERE source_id=$1", [sourceId, contentType, parsed.byteSize ?? byteSize, parsed.durationSeconds, parsed.width, parsed.height, parsed.videoCodec, parsed.audioCodec, parsed.frameRate, parsed.probe]);
      return parsed;
    } catch (error) {
      await this.db.query("UPDATE source_probes SET status='failed', error=$2, updated_at=now() WHERE source_id=$1", [sourceId, error instanceof Error ? error.message : 'ffprobe failed']);
      throw error;
    }
  }

  private async transcribe(jobId: string, _sourceId: string, mediaPath: string, durationSeconds: number | null) {
    const transcript = await this.db.query("INSERT INTO transcripts(job_id,status,provider,duration_seconds,updated_at) VALUES($1,'processing',$2,$3,now()) ON CONFLICT(job_id) DO UPDATE SET status='processing', provider=EXCLUDED.provider, error=NULL, updated_at=now() RETURNING id", [jobId, this.transcriber.constructor.name, durationSeconds]);
    const transcriptId = transcript.rows[0].id as string;
    try {
      const result = await this.transcriber.transcribe({ mediaPath, workDir: join(process.env.TMPDIR ?? '/tmp', 'clipper-transcripts', jobId) });
      const segments = result.segments.flatMap((segment) => {
        const text = sanitizeTranscriptText(segment.text);
        return text ? [{ ...segment, text }] : [];
      });
      const fullText = segments.map((segment) => segment.text).join(' ').trim();
      const connection = await this.db.connect();
      try {
        await connection.query('BEGIN');
        await connection.query("UPDATE transcripts SET status='completed', provider=$2, language=$3, full_text=$4, duration_seconds=$5, error=NULL, updated_at=now() WHERE id=$1", [transcriptId, result.provider, result.language, fullText, result.durationSeconds ?? durationSeconds]);
        await connection.query('DELETE FROM transcript_segments WHERE transcript_id=$1', [transcriptId]);
        for (const segment of segments) await connection.query('INSERT INTO transcript_segments(transcript_id,start_seconds,end_seconds,text) VALUES($1,$2,$3,$4)', [transcriptId, segment.startSeconds, segment.endSeconds, segment.text]);
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
      return { id: transcriptId, segmentCount: segments.length, segments };
    } catch (error) {
      await this.db.query("UPDATE transcripts SET status='failed', error=$2, updated_at=now() WHERE id=$1", [transcriptId, error instanceof Error ? error.message : 'transcription failed']);
      throw error;
    }
  }

  private async persistCandidates(jobId: string, transcriptId: string, segments: TranscriptSegment[], durationSeconds: number | null) {
    const proposals = this.candidateProvider.generate({ segments, durationSeconds });
    for (const proposal of proposals) await this.persistCandidate(jobId, transcriptId, proposal);
    const count = await this.db.query('SELECT COUNT(*)::int AS count FROM clip_candidates WHERE job_id=$1', [jobId]);
    return count.rows[0].count as number;
  }

  private async persistCandidate(jobId: string, transcriptId: string, proposal: CandidateProposal) {
    await this.db.query("INSERT INTO clip_candidates(job_id,transcript_id,start_seconds,end_seconds,score,confidence,rationale,evidence,social_copy,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(job_id,start_seconds,end_seconds) DO UPDATE SET transcript_id=EXCLUDED.transcript_id, score=EXCLUDED.score, confidence=EXCLUDED.confidence, rationale=EXCLUDED.rationale, evidence=EXCLUDED.evidence, social_copy=EXCLUDED.social_copy, metadata=EXCLUDED.metadata WHERE clip_candidates.review_status='proposed'", [jobId, transcriptId, proposal.startSeconds, proposal.endSeconds, proposal.score, proposal.confidence, proposal.rationale, JSON.stringify(proposal.evidence), JSON.stringify(proposal.socialCopy), JSON.stringify({ provider: this.candidateProvider.name, ...proposal.metadata })]);
  }
}

export class FixtureProcessor extends MediaProcessor {}

class ByteLimitTransform extends Transform {
  private byteSize = 0;

  constructor(private readonly limit: number) {
    super();
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
    this.byteSize += chunk.length;
    if (this.byteSize > this.limit) callback(new Error(`Source exceeds MAX_SOURCE_BYTES (${this.limit})`));
    else callback(null, chunk);
  }
}

function numberOrNull(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value: unknown) {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.round(parsed);
}

function parseRate(value: string) {
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function isMissingFile(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function runCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`)));
  });
}
