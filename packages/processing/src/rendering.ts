import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { AssetStore } from '@clipper/storage';
import {
  findChromiumExecutable,
  renderWithChromiumOverlay,
  videoEncoderArgs,
  type ChromiumOverlayCard,
  type ChromiumOverlayEvent,
  type ChromiumOverlayNameTag,
  type VideoEncoder,
} from './chromium-overlay.js';

const execFile = promisify(execFileCallback);

export type RenderProfileName = 'vertical_reel' | 'square' | 'landscape';
export type RenderFitMode = 'cover' | 'contain';
export type RenderBackground = 'black' | 'white' | 'dark_blue' | 'blurred';
export type LogoPosition = 'top-left' | 'top-center' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right';
export type CaptionMode = 'none' | 'sidecar' | 'burned';

export const renderProfiles: Record<RenderProfileName, {
  width: number;
  height: number;
  marginX: number;
  safeTop: number;
  safeBottom: number;
  logoHeight: number;
  captionMarginV: number;
}> = {
  vertical_reel: { width: 1080, height: 1920, marginX: 64, safeTop: 280, safeBottom: 280, logoHeight: 64, captionMarginV: 360 },
  square: { width: 1080, height: 1080, marginX: 64, safeTop: 64, safeBottom: 64, logoHeight: 64, captionMarginV: 96 },
  landscape: { width: 1920, height: 1080, marginX: 96, safeTop: 96, safeBottom: 96, logoHeight: 96, captionMarginV: 96 },
};

interface RenderJobRow {
  id: string;
  candidate_id: string;
  profile: RenderProfileName;
  fit_mode: RenderFitMode;
  background: RenderBackground;
  logo_position: LogoPosition;
  logo_asset_id: string | null;
  caption_mode: CaptionMode;
  include_logo: boolean;
  start_seconds: string | number;
  end_seconds: string | number;
  edited_start_seconds: string | number | null;
  edited_end_seconds: string | number | null;
  transcript_id: string | null;
  source_id: string;
  source_storage_key: string;
  social_copy: Record<string, unknown>;
  render_spec: Record<string, unknown> | null;
};

interface CaptionSegment {
  start_seconds: string | number;
  end_seconds: string | number;
  text: string;
}

export type CaptionWord = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

export type CaptionEvent = {
  startSeconds: number;
  endSeconds: number;
  text: string;
  words: CaptionWord[];
};

type TranscriptEdits = Record<string, string>;
type SubtitlePosition = { x: number; y: number };

type CaptionStyle = {
  fontFamily?: unknown;
  fontWeight?: unknown;
  fontSizePx?: unknown;
  lineHeight?: unknown;
  gapEm?: unknown;
  maxWidthPercent?: unknown;
  color?: unknown;
  activeColor?: unknown;
  backgroundColor?: unknown;
  textAlign?: unknown;
  textShadow?: unknown;
};

type ResolvedRenderSpec = {
  schema?: unknown;
  rendererTarget?: unknown;
  source?: { startSeconds?: unknown; endSeconds?: unknown };
  video?: { reframe?: unknown };
  logo?: { heightPercent?: unknown; placementMode?: unknown; anchorPercent?: unknown };
  headlineCards?: unknown;
  nameTags?: unknown;
  captions?: {
    positionPercent?: unknown;
    highlightMode?: unknown;
    words?: unknown;
    lines?: unknown;
    style?: unknown;
  };
};

type ResolvedRenderWordSpec = {
  id?: unknown;
  text?: unknown;
  startSeconds?: unknown;
  endSeconds?: unknown;
};

type ResolvedCaptionLineSpec = {
  wordIds?: unknown;
  text?: unknown;
  startSeconds?: unknown;
  endSeconds?: unknown;
};

type RenderVideoResult = {
  renderer: 'headless_chromium+ffmpeg' | 'ffmpeg';
  encoder: VideoEncoder;
  overlayMs: number;
  encodingMs: number;
};

type RenderTimings = {
  encoder: VideoEncoder;
  r2MaterializationMs: number;
  chromiumOverlayMs: number;
  ffmpegEncodingMs: number;
  thumbnailMs: number;
  r2UploadsMs: number;
  manifestUploadMs: number;
  retryWaitMs: number;
  leaseRefreshes: number;
  recoveredExpiredRenders: number;
};

export class RenderProcessor {
  private readonly ffmpegBinary: string;
  private readonly brandLogoPath: string;
  private readonly brandFontPath: string | null;
  private readonly brandFontName: string;
  private readonly ffprobeBinary: string;
  private encoderPromise: Promise<VideoEncoder> | null = null;

  constructor(
    private readonly db: pg.Pool,
    private readonly store: AssetStore,
    private readonly leaseSeconds = 60,
    options: { ffmpegBinary?: string; ffprobeBinary?: string; brandLogoPath?: string; brandFontPath?: string; brandFontName?: string } = {},
  ) {
    this.ffmpegBinary = options.ffmpegBinary ?? process.env.FFMPEG_BIN ?? 'ffmpeg';
    this.ffprobeBinary = options.ffprobeBinary ?? process.env.FFPROBE_BIN ?? 'ffprobe';
    this.brandLogoPath = options.brandLogoPath ?? process.env.BRAND_LOGO_PATH ?? resolve(process.cwd(), 'assets/brand/axios-logo.png');
    this.brandFontPath = options.brandFontPath ?? process.env.BRAND_FONT_PATH ?? null;
    this.brandFontName = options.brandFontName ?? process.env.BRAND_FONT_NAME ?? (this.brandFontPath ? 'NB International Pro' : 'DejaVu Sans');
  }

  async recoverExpired() {
    const result = await this.db.query(`
      WITH expired AS (
        SELECT id, GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - lease_expires_at)) * 1000) AS overdue_ms
        FROM clip_renders
        WHERE status='processing' AND lease_expires_at < clock_timestamp()
        FOR UPDATE SKIP LOCKED
      ), reset AS (
        UPDATE clip_renders AS render
        SET status='queued', claimed_at=NULL, lease_expires_at=NULL, updated_at=now()
        FROM expired
        WHERE render.id=expired.id
        RETURNING render.id
      )
      SELECT COUNT(reset.id)::int AS count, COALESCE(SUM(expired.overdue_ms), 0)::float AS retry_wait_ms
      FROM reset JOIN expired ON expired.id=reset.id
    `);
    return {
      count: Number(result.rows[0]?.count ?? 0),
      retryWaitMs: Number(result.rows[0]?.retry_wait_ms ?? 0),
    };
  }

  async runOnce() {
    const recovery = await this.recoverExpired();
    const claim = await this.db.query("WITH selected_render AS (SELECT id FROM clip_renders WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE clip_renders AS r SET status='processing', attempts=r.attempts+1, claimed_at=now(), lease_expires_at=now() + ($1 * interval '1 second'), progress=5, updated_at=now() FROM selected_render AS s WHERE r.id=s.id RETURNING r.id, r.attempts", [this.leaseSeconds]);
    if (!claim.rowCount) return null;
    const renderId = claim.rows[0].id as string;
    const attempt = Number(claim.rows[0].attempts ?? 0);
    const timings: RenderTimings = {
      encoder: 'libx264',
      r2MaterializationMs: 0,
      chromiumOverlayMs: 0,
      ffmpegEncodingMs: 0,
      thumbnailMs: 0,
      r2UploadsMs: 0,
      manifestUploadMs: 0,
      leaseRefreshes: 0,
      recoveredExpiredRenders: recovery.count,
      retryWaitMs: recovery.retryWaitMs,
    };
    const totalStartedAt = nowMs();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let leaseLost = false;
    const workDir = join(process.env.TMPDIR ?? '/tmp', 'clipper-renders', renderId);
    const refreshLease = async () => {
      try {
        const result = await this.db.query("UPDATE clip_renders SET lease_expires_at=now() + ($2 * interval '1 second'), updated_at=now() WHERE id=$1 AND status='processing'", [renderId, this.leaseSeconds]);
        if (result.rowCount) timings.leaseRefreshes += 1;
        else leaseLost = true;
      } catch {
        // A transient heartbeat error is tolerated; the completion guard below
        // prevents an expired worker from publishing stale output.
      }
    };
    const reportTimings = (status: 'completed' | 'failed', error?: unknown) => {
      console.info(JSON.stringify({
        event: 'render.timing',
        renderId,
        attempt,
        status,
        encoder: timings.encoder,
        totalWallMs: Math.round(nowMs() - totalStartedAt),
        timings,
        ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
      }));
    };
    try {
      void refreshLease();
      heartbeat = setInterval(() => { void refreshLease(); }, Math.max(5_000, Math.floor(this.leaseSeconds * 333)));
      heartbeat.unref?.();
      const job = await this.loadRenderJob(renderId);
      const profile = renderProfiles[job.profile];
      const startSeconds = Number(job.edited_start_seconds ?? job.start_seconds);
      const endSeconds = Number(job.edited_end_seconds ?? job.end_seconds);
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) throw new Error('Render window must have a positive duration');
      await mkdir(workDir, { recursive: true });
      const materializationStartedAt = nowMs();
      const sourcePath = await this.store.materialize(job.source_storage_key, join(workDir, 'source'));
      timings.r2MaterializationMs = Math.round(nowMs() - materializationStartedAt);
      const logoPath = job.include_logo ? await this.logoPathFor(job.logo_asset_id, workDir) : null;
      await assertFile(sourcePath, 'source asset');
      if (job.include_logo && logoPath) await assertFile(logoPath, job.logo_asset_id ? 'selected brand asset' : 'BRAND_LOGO_PATH');
      if (job.caption_mode === 'burned' && this.brandFontPath) await assertFile(this.brandFontPath, 'BRAND_FONT_PATH');

      await this.updateProgress(renderId, 20);
      const renderSpec = readRenderSpec(job.render_spec);
      const captions = job.caption_mode === 'none' ? { srt: null, ass: null, count: 0, events: [] as CaptionEvent[] } : await this.prepareCaptions(job.transcript_id, startSeconds, endSeconds, profile, workDir, job.social_copy, renderSpec);
      const headlineCards = readHeadlineCardsFromSpec(renderSpec) ?? readHeadlineCards(job.social_copy);
      const nameTags = readNameTagsFromSpec(renderSpec) ?? readNameTags(job.social_copy);
      await this.updateProgress(renderId, 35);
      const outputPath = join(workDir, 'clip.mp4');
      const renderResult = await this.renderVideo(job, sourcePath, profile, job.fit_mode, job.background, job.logo_position, logoPath, startSeconds, endSeconds, job.caption_mode === 'burned' ? captions.ass : null, captions.events, headlineCards, nameTags, renderSpec, workDir, outputPath);
      timings.encoder = renderResult.encoder;
      timings.chromiumOverlayMs = Math.round(renderResult.overlayMs);
      timings.ffmpegEncodingMs = Math.round(renderResult.encodingMs);
      if (leaseLost) throw new LeaseLostError(renderId);
      const thumbnailPath = join(workDir, 'thumbnail.jpg');
      const thumbnailStartedAt = nowMs();
      await this.renderThumbnail(sourcePath, profile, job.fit_mode, job.background, startSeconds, thumbnailPath);
      timings.thumbnailMs = Math.round(nowMs() - thumbnailStartedAt);
      await this.updateProgress(renderId, 70);

      const uploadsStartedAt = nowMs();
      const [videoAsset, thumbnailAsset, captionAsset] = await Promise.all([
        this.storeFileAsset(job.source_id, `renders/${renderId}/clip.mp4`, outputPath, 'video/mp4', 'render'),
        this.storeFileAsset(job.source_id, `renders/${renderId}/thumbnail.jpg`, thumbnailPath, 'image/jpeg', 'render'),
        captions.srt
          ? readFile(captions.srt).then((body) => this.storeBufferAsset(job.source_id, `renders/${renderId}/captions.srt`, body, 'application/x-subrip', 'transcript'))
          : Promise.resolve(null),
      ]);
      timings.r2UploadsMs = Math.round(nowMs() - uploadsStartedAt);
      const manifest = {
        schema: 'axios.clip.render.v1',
        brandGuidelines: 'Axios Brand Guidelines v1.2 Agency Onboarding',
        renderer: renderResult.renderer,
        renderSpecUsed: Boolean(renderSpec),
        renderSpec: renderSpec ?? null,
        profile: job.profile,
        fitMode: job.fit_mode,
        background: job.background,
        logoPosition: job.logo_position,
        dimensions: { width: profile.width, height: profile.height, fps: 30 },
        source: { sourceId: job.source_id, storageKey: job.source_storage_key },
        candidate: { candidateId: job.candidate_id, startSeconds, endSeconds },
        branding: { includeLogo: job.include_logo, logoAssetId: job.logo_asset_id, logoSource: job.logo_asset_id ? 'brand_asset' : 'default', fontName: this.brandFontName, fontPathConfigured: Boolean(this.brandFontPath) },
        captions: { mode: job.caption_mode, segmentCount: captions.count, sidecarAsset: captionAsset?.id ?? null },
        headlineCards,
        nameTags,
        socialCopy: job.social_copy,
        editable: { trimStartSeconds: startSeconds, trimEndSeconds: endSeconds, profile: job.profile, fitMode: job.fit_mode, logoPosition: job.logo_position, captionMode: job.caption_mode },
      };
      const manifestUploadStartedAt = nowMs();
      const manifestAsset = await this.storeBufferAsset(job.source_id, `renders/${renderId}/render-manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json', 'render');
      timings.manifestUploadMs = Math.round(nowMs() - manifestUploadStartedAt);
      await this.updateProgress(renderId, 90);
      const completed = await this.db.query("UPDATE clip_renders SET status='completed', progress=100, completed_at=now(), lease_expires_at=NULL, asset_id=$2, thumbnail_asset_id=$3, caption_asset_id=$4, manifest_asset_id=$5, render_manifest=$6, error=NULL, updated_at=now() WHERE id=$1 AND status='processing'", [renderId, videoAsset.id, thumbnailAsset.id, captionAsset?.id ?? null, manifestAsset.id, JSON.stringify(manifest)]);
      if (!completed.rowCount) {
        leaseLost = true;
        throw new LeaseLostError(renderId);
      }
      reportTimings('completed');
      return renderId;
    } catch (error) {
      if (!leaseLost && !(error instanceof LeaseLostError)) {
        await this.db.query("UPDATE clip_renders SET status='failed', error=$2, lease_expires_at=NULL, updated_at=now() WHERE id=$1 AND status='processing'", [renderId, error instanceof Error ? error.message : 'render failed']);
      }
      reportTimings('failed', error);
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async loadRenderJob(renderId: string) {
    const result = await this.db.query("SELECT r.id, r.candidate_id, r.profile, r.fit_mode, r.background, r.logo_position, r.logo_asset_id, r.caption_mode, r.include_logo, r.render_spec, c.job_id, c.transcript_id, c.start_seconds, c.end_seconds, c.edited_start_seconds, c.edited_end_seconds, c.social_copy, j.source_id, a.storage_key AS source_storage_key FROM clip_renders r JOIN clip_candidates c ON c.id=r.candidate_id JOIN processing_jobs j ON j.id=c.job_id JOIN assets a ON a.source_id=j.source_id AND a.role='source' WHERE r.id=$1 ORDER BY a.created_at DESC LIMIT 1", [renderId]);
    if (!result.rowCount) throw new Error(`Render ${renderId} has no source asset`);
    return result.rows[0] as RenderJobRow;
  }

  private async prepareCaptions(transcriptId: string | null, clipStart: number, clipEnd: number, profile: typeof renderProfiles[RenderProfileName], workDir: string, socialCopy: Record<string, unknown>, renderSpec: ResolvedRenderSpec | null) {
    if (!transcriptId) return { srt: null, ass: null, count: 0, events: [] as CaptionEvent[] };
    // Keep the complete ordered transcript so editor word IDs (segmentIndex-wordIndex)
    // remain stable when a clip starts in the middle of a transcript.
    const result = await this.db.query('SELECT start_seconds,end_seconds,text FROM transcript_segments WHERE transcript_id=$1 ORDER BY start_seconds', [transcriptId]);
    const segments = result.rows as CaptionSegment[];
    if (!segments.length) return { srt: null, ass: null, count: 0, events: [] as CaptionEvent[] };
    const transcriptEdits = readTranscriptEdits(socialCopy);
    const subtitlePosition = readCaptionPosition(renderSpec?.captions?.positionPercent)
      ?? readSubtitlePosition(socialCopy);
    const events = readCaptionEventsFromSpec(renderSpec, clipStart, clipEnd) ?? buildEditorCaptionEvents(segments, clipStart, clipEnd, transcriptEdits);
    if (!events.length) return { srt: null, ass: null, count: 0, events: [] as CaptionEvent[] };
    const srtPath = join(workDir, 'captions.srt');
    const assPath = join(workDir, 'captions.ass');
    await writeFile(srtPath, buildSrtFromEvents(events));
    await writeFile(assPath, buildAssFromEvents(events, profile, this.brandFontName, subtitlePosition, readCaptionStyle(renderSpec, socialCopy)));
    return { srt: srtPath, ass: assPath, count: events.length, events };
  }

  private async logoPathFor(logoAssetId: string | null, workDir: string) {
    if (!logoAssetId) return this.brandLogoPath;
    const result = await this.db.query('SELECT a.storage_key FROM brand_assets b JOIN assets a ON a.id=b.asset_id WHERE b.id=$1 AND b.active=true', [logoAssetId]);
    if (!result.rowCount) throw new Error(`Brand asset ${logoAssetId} was not found or is inactive`);
    return this.store.materialize(result.rows[0].storage_key as string, join(workDir, 'brand'));
  }

  private async renderVideo(job: RenderJobRow, sourcePath: string, profile: typeof renderProfiles[RenderProfileName], fitMode: RenderFitMode, background: RenderBackground, logoPosition: LogoPosition, logoPath: string | null, startSeconds: number, endSeconds: number, assPath: string | null, captionEvents: CaptionEvent[], headlineCards: HeadlineCardInput[], nameTags: NameTagInput[], renderSpec: ResolvedRenderSpec | null, workDir: string, outputPath: string): Promise<RenderVideoResult> {
    const logoHeight = readLogoHeight(profile, renderSpec);
    const encoder = await this.selectVideoEncoder();
    const requestedRenderer = typeof renderSpec?.rendererTarget === 'string'
      ? renderSpec.rendererTarget
      : process.env.RENDERER_TARGET ?? 'headless_chromium';
    const chromiumAvailable = requestedRenderer === 'headless_chromium' && Boolean(findChromiumExecutable());
    const hasExplicitRenderSpec = renderSpec?.schema === 'axios.clip.render-spec.v1';
    if (requestedRenderer === 'headless_chromium' && hasExplicitRenderSpec && !chromiumAvailable && process.env.RENDERER_REQUIRE_CHROMIUM !== 'false') {
      throw new Error('Exact render spec requires Chromium; no Chrome/Chromium executable is available');
    }
    if (chromiumAvailable) {
      const renderChromium = (videoEncoder: VideoEncoder) => renderWithChromiumOverlay({
        ffmpegBinary: this.ffmpegBinary,
        sourcePath,
        logoPath: job.include_logo ? logoPath : null,
        outputPath,
        workDir,
        baseFilter: baseVideoFilter(profile, fitMode, background, readVideoReframe(renderSpec)),
        logoFilter: job.include_logo && logoPath ? { ...logoOverlayPosition(profile, logoPosition, readLogoAnchorPercent(renderSpec)), height: logoHeight } : null,
        width: profile.width,
        height: profile.height,
        fps: 30,
        startSeconds,
        duration: endSeconds - startSeconds,
        headlineCards: headlineCards as unknown as ChromiumOverlayCard[],
        nameTags: nameTags as unknown as ChromiumOverlayNameTag[],
        captionEvents: job.caption_mode === 'burned' ? captionEvents as unknown as ChromiumOverlayEvent[] : [],
        captionPosition: readCaptionPosition(renderSpec?.captions?.positionPercent) ?? readSubtitlePosition(job.social_copy),
        captionStyle: readCaptionStyle(renderSpec, job.social_copy),
        fontPath: this.brandFontPath,
        videoEncoder,
        videoToolboxBitrate: process.env.FFMPEG_VT_BITRATE,
        ffmpegPreset: process.env.FFMPEG_PRESET,
        ffmpegCrf: process.env.FFMPEG_CRF,
      });
      try {
        const result = await renderChromium(encoder);
        await this.validateEncodedOutput(outputPath, profile);
        return { renderer: 'headless_chromium+ffmpeg', encoder, overlayMs: result.overlayMs, encodingMs: result.encodingMs };
      } catch (error) {
        if (encoder !== 'h264_videotoolbox') throw error;
        await rm(outputPath, { force: true });
        const fallback = await renderChromium('libx264');
        await this.validateEncodedOutput(outputPath, profile);
        console.warn(`VideoToolbox validation/render failed for ${outputPath}; used libx264 fallback: ${error instanceof Error ? error.message : String(error)}`);
        return { renderer: 'headless_chromium+ffmpeg', encoder: 'libx264', overlayMs: fallback.overlayMs, encodingMs: fallback.encodingMs };
      }
    }
    if (requestedRenderer === 'headless_chromium' && process.env.RENDERER_REQUIRE_CHROMIUM === 'true') {
      throw new Error('Chromium renderer requested, but no Chrome/Chromium executable is available');
    }
    const fontsDir = this.brandFontPath ? `:fontsdir=${escapeFilterPath(dirname(this.brandFontPath))}` : '';
    const headlineFilter = await buildHeadlineCardFilter(headlineCards, endSeconds - startSeconds, profile, workDir, this.brandFontPath);
    const nameTagFilter = await buildNameTagFilter(nameTags, endSeconds - startSeconds, profile, workDir, this.brandFontPath);
    // Captions sit below headline cards/name tags in the editor (z-index 2 vs
    // z-index 3). Apply them first so later overlays cannot be painted over.
    const captionFilter = assPath ? `,subtitles=${escapeFilterPath(assPath)}${fontsDir}` : '';
    const baseFilter = `${baseVideoFilter(profile, fitMode, background, readVideoReframe(renderSpec))}${captionFilter}${headlineFilter}${nameTagFilter}`;
    const duration = (endSeconds - startSeconds).toFixed(3);
    const args = ['-y', '-ss', startSeconds.toFixed(3), '-i', sourcePath];
    if (job.include_logo && logoPath) {
      const position = logoOverlayPosition(profile, logoPosition, readLogoAnchorPercent(renderSpec));
      args.push('-loop', '1', '-i', logoPath, '-filter_complex', `[0:v]${baseFilter}[base];[1:v]scale=-1:${logoHeight}[logo];[base][logo]overlay=${position.x}:${position.y}:format=auto[v]`, '-map', '[v]');
    } else {
      args.push('-vf', baseFilter, '-map', '0:v:0');
    }
    args.push('-map', '0:a?', '-t', duration, '-r', '30', ...videoEncoderArgs(encoder, process.env.FFMPEG_PRESET ?? 'veryfast', process.env.FFMPEG_CRF ?? '20', process.env.FFMPEG_VT_BITRATE ?? '8M'), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-movflags', '+faststart', outputPath);
    const encodingStartedAt = nowMs();
    try {
      await runCommand(this.ffmpegBinary, args);
      await this.validateEncodedOutput(outputPath, profile);
      return { renderer: 'ffmpeg', encoder, overlayMs: 0, encodingMs: nowMs() - encodingStartedAt };
    } catch (error) {
      if (encoder !== 'h264_videotoolbox') throw error;
      await rm(outputPath, { force: true });
      const fallbackArgs = [...args];
      const encoderIndex = fallbackArgs.indexOf('-c:v');
      fallbackArgs.splice(encoderIndex, 8, ...videoEncoderArgs('libx264', process.env.FFMPEG_PRESET ?? 'veryfast', process.env.FFMPEG_CRF ?? '20', process.env.FFMPEG_VT_BITRATE ?? '8M'));
      const fallbackStartedAt = nowMs();
      await runCommand(this.ffmpegBinary, fallbackArgs);
      await this.validateEncodedOutput(outputPath, profile);
      console.warn(`VideoToolbox validation/render failed for ${outputPath}; used libx264 fallback: ${error instanceof Error ? error.message : String(error)}`);
      return { renderer: 'ffmpeg', encoder: 'libx264', overlayMs: 0, encodingMs: nowMs() - fallbackStartedAt };
    }
  }

  private async selectVideoEncoder(): Promise<VideoEncoder> {
    const requested = (process.env.FFMPEG_VIDEO_ENCODER ?? 'auto').toLowerCase();
    if (requested === 'libx264') return 'libx264';
    const hasVideoToolbox = await this.hasVideoToolboxEncoder();
    if (requested === 'h264_videotoolbox' || requested === 'videotoolbox' || requested === 'auto') {
      return hasVideoToolbox ? 'h264_videotoolbox' : 'libx264';
    }
    return 'libx264';
  }

  private async hasVideoToolboxEncoder() {
    if (process.platform !== 'darwin') return false;
    if (!this.encoderPromise) {
      this.encoderPromise = execFile(this.ffmpegBinary, ['-hide_banner', '-encoders']).then(({ stdout, stderr }) => /h264_videotoolbox/.test(`${stdout}\n${stderr}`)).then((available) => available ? 'h264_videotoolbox' : 'libx264');
    }
    return (await this.encoderPromise) === 'h264_videotoolbox';
  }

  private async validateEncodedOutput(outputPath: string, profile: typeof renderProfiles[RenderProfileName]) {
    const { stdout } = await execFile(this.ffprobeBinary, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', outputPath]);
    const streams = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string }> };
    const video = streams.streams?.find((stream) => stream.codec_type === 'video');
    const audio = streams.streams?.find((stream) => stream.codec_type === 'audio');
    if (!video || video.codec_name !== 'h264' || video.width !== profile.width || video.height !== profile.height || frameRate(video.r_frame_rate) !== 30) {
      throw new Error(`Encoded video validation failed for ${outputPath}`);
    }
    if (!audio || audio.codec_name !== 'aac') throw new Error(`Encoded audio validation failed for ${outputPath}`);
  }

  private async renderThumbnail(sourcePath: string, profile: typeof renderProfiles[RenderProfileName], fitMode: RenderFitMode, background: RenderBackground, startSeconds: number, outputPath: string) {
    await runCommand(this.ffmpegBinary, ['-y', '-ss', startSeconds.toFixed(3), '-i', sourcePath, '-frames:v', '1', '-vf', baseVideoFilter(profile, fitMode, background), '-q:v', '2', outputPath]);
  }

  private async storeFileAsset(sourceId: string, key: string, path: string, contentType: string, role: 'render' | 'transcript') {
    const stored = await this.store.putStream(key, createReadStream(path));
    return this.insertAsset(sourceId, key, contentType, stored.byteSize, role);
  }

  private async storeBufferAsset(sourceId: string, key: string, body: Buffer, contentType: string, role: 'render' | 'transcript') {
    await this.store.put(key, body);
    return this.insertAsset(sourceId, key, contentType, body.byteLength, role);
  }

  private async insertAsset(sourceId: string, key: string, contentType: string, byteSize: number, role: 'render' | 'transcript') {
    const result = await this.db.query('INSERT INTO assets(source_id,storage_key,role,content_type,byte_size,public_reference,metadata) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(storage_key) DO UPDATE SET byte_size=EXCLUDED.byte_size, content_type=EXCLUDED.content_type, role=EXCLUDED.role RETURNING id,storage_key,content_type,byte_size,public_reference', [sourceId, key, role, contentType, byteSize, this.store.getPublicReference(key), { renderer: 'ffmpeg' }]);
    return result.rows[0] as { id: string; storage_key: string; content_type: string; byte_size: number; public_reference: string };
  }

  private async updateProgress(renderId: string, progress: number) {
    await this.db.query("UPDATE clip_renders SET progress=$2, lease_expires_at=now() + ($3 * interval '1 second'), updated_at=now() WHERE id=$1 AND status='processing'", [renderId, progress, this.leaseSeconds]);
  }
}

type HeadlineCardInput = {
  id: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
  color: string;
  shape: 'rounded' | 'pill';
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  transitionSeconds: number;
  lines?: string[];
  backgroundColor?: string;
  textColor?: string;
  borderRadiusPx?: number;
  border?: string;
  boxShadow?: string;
  fontFamily?: string;
  fontWeight?: number;
  fontSizePx?: number;
  lineHeight?: number;
  textAlign?: string;
  paddingPx?: { horizontal: number; vertical: number };
};

type NameTagInput = {
  id: string;
  name: string;
  title: string;
  startSeconds: number;
  endSeconds: number;
  color: string;
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  transitionSeconds: number;
  backgroundColor?: string;
  textColor?: string;
  border?: string;
  boxShadow?: string;
  fontFamily?: string;
  fontWeight?: number;
  borderRadiusPx?: number;
  fontSizePx?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readRenderSpec(value: unknown): ResolvedRenderSpec | null {
  return asRecord(value) as ResolvedRenderSpec | null;
}

function readLogoAnchorPercent(spec: ResolvedRenderSpec | null): { x: number; y: number } | undefined {
  if (spec?.logo?.placementMode !== 'freeform') return undefined;
  const anchor = asRecord(spec.logo.anchorPercent);
  const x = Number(anchor?.x);
  const y = Number(anchor?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
}

type VideoReframe = { x: number; y: number; scale: number };

function readVideoReframe(spec: ResolvedRenderSpec | null): VideoReframe | undefined {
  const reframe = asRecord(spec?.video?.reframe);
  if (!reframe) return undefined;
  return {
    x: clampRange(reframe.x, 0, 100, 50),
    y: clampRange(reframe.y, 0, 100, 50),
    scale: clampRange(reframe.scale, 0.75, 1.75, 1),
  };
}

function readStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : undefined;
}

function readColor(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readGeometry(value: unknown, defaults: { x: number; y: number; width: number; height: number }, limits: { minWidth: number; maxWidth: number; minHeight: number; maxHeight: number }) {
  const geometry = asRecord(value);
  return boundedOverlayGeometry(geometry?.x, geometry?.y, geometry?.width, geometry?.height, defaults, limits);
}

function readHeadlineCardsFromSpec(spec: ResolvedRenderSpec | null): HeadlineCardInput[] | null {
  if (!spec || !Array.isArray(spec.headlineCards)) return null;
  return spec.headlineCards.flatMap((value, index) => {
    const card = asRecord(value);
    if (!card) return [];
    const style = asRecord(card.style);
    const text = typeof card.text === 'string' ? card.text.trim().slice(0, 180) : '';
    const startSeconds = Number(card.startSeconds);
    const endSeconds = Number(card.endSeconds);
    if (!text || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return [];
    const geometry = readGeometry(card.geometryPercent ?? {
      x: card.xPercent,
      y: card.yPercent,
      width: card.widthPercent,
      height: card.heightPercent,
    }, { x: 50, y: 70, width: 84, height: 21 }, { minWidth: 12, maxWidth: 92, minHeight: 8, maxHeight: 70 });
    const padding = asRecord(style?.paddingPx);
    const topLevelPadding = asRecord(card.paddingPx);
    const lines = readStringArray(card.lines);
    return [{
      id: typeof card.id === 'string' && card.id ? card.id : `headline-${index + 1}`,
      text,
      lines,
      startSeconds: Math.max(0, Math.min(60, startSeconds)),
      endSeconds: Math.max(0, Math.min(60, endSeconds)),
      color: typeof card.color === 'string' ? card.color : 'navy',
      shape: card.shape === 'pill' ? ('pill' as const) : ('rounded' as const),
      ...geometry,
      transitionSeconds: clampRange(card.transitionSeconds, 0.05, 2, 0.35),
      backgroundColor: readColor(style?.backgroundColor, readColor(card.backgroundColor, '')),
      textColor: readColor(style?.textColor, readColor(card.textColor, '')),
      border: readColor(style?.border, readColor(card.border, '')),
      boxShadow: readColor(style?.boxShadow, readColor(card.boxShadow, '')),
      fontFamily: readColor(style?.fontFamily, readColor(card.fontFamily, '')),
      fontWeight: clampRange(style?.fontWeight ?? card.fontWeight, 100, 900, 700),
      borderRadiusPx: clampRange(style?.borderRadiusPx ?? card.borderRadiusPx, 0, 999, card.shape === 'pill' ? 999 : 12),
      // The editor exposes headline-card sizes up to 160 output pixels. Keep
      // the render-spec value intact so a deliberately enlarged card renders
      // at the same size as the editor; legacy cards without an explicit size
      // still use the renderer's fallback fitting below.
      fontSizePx: clampRange(style?.fontSizePx ?? card.fontSizePx, 5, 160, 0),
      lineHeight: clampRange(style?.lineHeight ?? card.lineHeight, 0.8, 2, 1.1),
      textAlign: readColor(style?.textAlign, readColor(card.textAlign, 'center')),
      paddingPx: {
        horizontal: clampRange(padding?.horizontal ?? topLevelPadding?.horizontal ?? card.paddingHorizontalPx, 0, 96, 18),
        vertical: clampRange(padding?.vertical ?? topLevelPadding?.vertical ?? card.paddingVerticalPx, 0, 96, 10),
      },
    }];
  }).filter((card) => card.endSeconds > card.startSeconds).slice(0, 12);
}

function readNameTagsFromSpec(spec: ResolvedRenderSpec | null): NameTagInput[] | null {
  if (!spec || !Array.isArray(spec.nameTags)) return null;
  return spec.nameTags.flatMap((value, index) => {
    const tag = asRecord(value);
    if (!tag) return [];
    const style = asRecord(tag.style);
    const name = typeof tag.name === 'string' ? tag.name.trim().slice(0, 80) : '';
    const title = typeof tag.title === 'string' ? tag.title.trim().slice(0, 100) : '';
    const startSeconds = Number(tag.startSeconds);
    const endSeconds = Number(tag.endSeconds);
    if ((!name && !title) || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return [];
    const geometry = readGeometry(tag.geometryPercent ?? {
      x: tag.xPercent,
      y: tag.yPercent,
      width: tag.widthPercent,
      height: tag.heightPercent,
    }, { x: 32, y: 78, width: 58, height: 14 }, { minWidth: 18, maxWidth: 70, minHeight: 8, maxHeight: 42 });
    return [{
      id: typeof tag.id === 'string' && tag.id ? tag.id : `nametag-${index + 1}`,
      name,
      title,
      startSeconds: Math.max(0, Math.min(60, startSeconds)),
      endSeconds: Math.max(0, Math.min(60, endSeconds)),
      color: typeof tag.color === 'string' ? tag.color : 'white',
      ...geometry,
      transitionSeconds: clampRange(tag.transitionSeconds, 0.05, 2, 0.35),
      backgroundColor: readColor(style?.backgroundColor, readColor(tag.backgroundColor, '')),
      textColor: readColor(style?.textColor, readColor(tag.textColor, '')),
      border: readColor(style?.border, readColor(tag.border, '')),
      boxShadow: readColor(style?.boxShadow, readColor(tag.boxShadow, '')),
      fontFamily: readColor(style?.fontFamily, readColor(tag.fontFamily, '')),
      fontWeight: clampRange(style?.fontWeight ?? tag.fontWeight, 100, 900, 700),
      borderRadiusPx: clampRange(style?.borderRadiusPx ?? tag.borderRadiusPx, 0, 999, 2),
      fontSizePx: clampRange(style?.fontSizePx ?? tag.fontSizePx, 5, 96, 0),
    }];
  }).filter((tag) => tag.endSeconds > tag.startSeconds).slice(0, 12);
}

function readCaptionStyle(spec: ResolvedRenderSpec | null, socialCopy?: Record<string, unknown>): CaptionStyle | undefined {
  const style = asRecord(spec?.captions?.style);
  if (style) return style as CaptionStyle;
  const fontSizePx = Number(socialCopy?.subtitleFontSizePx);
  if (!Number.isFinite(fontSizePx)) return undefined;
  // Older render snapshots did not carry resolved visual lines, but the saved
  // editor state still has the producer-selected size. Reuse the editor's
  // defaults so Chromium can safely wrap those legacy caption groups.
  return {
    fontFamily: 'NB International Pro',
    fontWeight: 700,
    fontSizePx: clampRange(fontSizePx, 22, 72, 42),
    lineHeight: 1.18,
    gapEm: 0.32,
    maxWidthPercent: 84,
    color: '#ffffff',
    activeColor: '#3b6be3',
    backgroundColor: 'transparent',
    textAlign: 'center',
    textShadow: '0 2px 5px rgba(0, 0, 0, 0.9), 0 0 2px rgba(0, 0, 0, 0.9)',
  };
}

function readLogoHeight(profile: typeof renderProfiles[RenderProfileName], spec: ResolvedRenderSpec | null) {
  const defaultPercent = (profile.logoHeight / profile.height) * 100;
  const percent = clampRange(spec?.logo?.heightPercent, 1, 24, defaultPercent);
  return Math.max(1, Math.round(profile.height * percent / 100));
}

function readCaptionPosition(value: unknown): SubtitlePosition | undefined {
  const position = asRecord(value);
  if (!position) return undefined;
  return { x: clampRange(position.x, 10, 90, 50), y: clampRange(position.y, 8, 92, 84) };
}

function renderSpecTime(value: unknown, clipStart: number, sourceStart: number | null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  // Headline-card times are already relative to the clip. Caption word times
  // are source-absolute in the editor snapshot. Use the saved source start to
  // support both forms without shifting a relative value twice.
  return sourceStart !== null && numeric >= sourceStart - 0.001 ? numeric - clipStart : numeric;
}

function readCaptionEventsFromSpec(spec: ResolvedRenderSpec | null, clipStart: number, clipEnd: number): CaptionEvent[] | null {
  const captions = spec?.captions;
  if (!captions || !Array.isArray(captions.lines) || !Array.isArray(captions.words)) return null;
  const sourceStartValue = Number(spec.source?.startSeconds);
  const sourceStart = Number.isFinite(sourceStartValue) ? sourceStartValue : null;
  const wordsById = new Map<string, CaptionWord>();
  for (const rawWord of captions.words as unknown[]) {
    const word = asRecord(rawWord) as ResolvedRenderWordSpec | null;
    if (!word || typeof word.id !== 'string' || typeof word.text !== 'string') continue;
    const startSeconds = renderSpecTime(word.startSeconds, clipStart, sourceStart);
    const endSeconds = renderSpecTime(word.endSeconds, clipStart, sourceStart);
    if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds) continue;
    const start = Math.max(0, startSeconds);
    const end = Math.min(clipEnd - clipStart, endSeconds);
    if (end <= 0 || start >= clipEnd - clipStart) continue;
    wordsById.set(word.id, { startSeconds: start, endSeconds: end, text: cleanCaptionText(word.text) });
  }
  const events = (captions.lines as unknown[]).flatMap((rawLine) => {
    const line = asRecord(rawLine) as ResolvedCaptionLineSpec | null;
    if (!line) return [];
    const ids = Array.isArray(line.wordIds) ? line.wordIds.filter((id): id is string => typeof id === 'string') : [];
    const words = ids.map((id) => wordsById.get(id)).filter((word): word is CaptionWord => Boolean(word && word.text));
    const lineStart = renderSpecTime(line.startSeconds, clipStart, sourceStart);
    const lineEnd = renderSpecTime(line.endSeconds, clipStart, sourceStart);
    if (!words.length && typeof line.text !== 'string') return [];
    const fallbackStart = lineStart === null ? words[0]?.startSeconds : Math.max(0, lineStart);
    const fallbackEnd = lineEnd === null ? words.at(-1)?.endSeconds : Math.min(clipEnd - clipStart, lineEnd);
    if (fallbackStart === undefined || fallbackEnd === undefined || fallbackEnd <= fallbackStart) return [];
    const visibleWords = words.length ? words : [{ startSeconds: fallbackStart, endSeconds: fallbackEnd, text: cleanCaptionText(line.text as string) }];
    return [{ startSeconds: fallbackStart, endSeconds: fallbackEnd, text: visibleWords.map((word) => word.text).join(' '), words: visibleWords }];
  });
  return events.length ? events : null;
}

function readHeadlineCards(socialCopy: Record<string, unknown>): HeadlineCardInput[] {
  if (!Array.isArray(socialCopy.headlineCards)) return [];
  return socialCopy.headlineCards.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return [];
    const card = value as Record<string, unknown>;
    const text = typeof card.text === 'string' ? card.text.trim().slice(0, 180) : '';
    const startSeconds = Number(card.startSeconds);
    const endSeconds = Number(card.endSeconds);
    if (!text || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return [];
    const placementCustomized = card.placementCustomized === true;
    const geometry = placementCustomized
      ? boundedOverlayGeometry(card.xPercent, card.yPercent, card.widthPercent, card.heightPercent, { x: 50, y: 70, width: 84, height: 21 }, { minWidth: 12, maxWidth: 92, minHeight: 8, maxHeight: 70 })
      : { xPercent: 50, yPercent: 70, widthPercent: 84, heightPercent: 21 };
    return [{
      id: typeof card.id === 'string' && card.id ? card.id : `headline-${index + 1}`,
      text,
      startSeconds: Math.max(0, Math.min(60, startSeconds)),
      endSeconds: Math.max(0, Math.min(60, endSeconds)),
      color: typeof card.color === 'string' ? card.color : 'navy',
      shape: card.shape === 'pill' ? ('pill' as const) : ('rounded' as const),
      ...geometry,
      transitionSeconds: clampRange(card.transitionSeconds, 0.05, 2, 0.35),
    }];
  }).filter((card) => card.endSeconds > card.startSeconds).slice(0, 12);
}

function readNameTags(socialCopy: Record<string, unknown>): NameTagInput[] {
  if (!Array.isArray(socialCopy.nameTags)) return [];
  return socialCopy.nameTags.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return [];
    const tag = value as Record<string, unknown>;
    const name = typeof tag.name === 'string' ? tag.name.trim().slice(0, 80) : '';
    const title = typeof tag.title === 'string' ? tag.title.trim().slice(0, 100) : '';
    const startSeconds = Number(tag.startSeconds);
    const endSeconds = Number(tag.endSeconds);
    if ((!name && !title) || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return [];
    const placementCustomized = tag.placementCustomized === true;
    const geometry = placementCustomized
      ? boundedOverlayGeometry(tag.xPercent, tag.yPercent, tag.widthPercent, tag.heightPercent, { x: 22, y: 78, width: 36, height: 16 }, { minWidth: 18, maxWidth: 70, minHeight: 8, maxHeight: 42 })
      : { xPercent: 32, yPercent: 78, widthPercent: 58, heightPercent: 14 };
    return [{
      id: typeof tag.id === 'string' && tag.id ? tag.id : `nametag-${index + 1}`,
      name,
      title,
      startSeconds: Math.max(0, Math.min(60, startSeconds)),
      endSeconds: Math.max(0, Math.min(60, endSeconds)),
      color: typeof tag.color === 'string' ? tag.color : 'white',
      ...geometry,
      transitionSeconds: clampRange(tag.transitionSeconds, 0.05, 2, 0.35),
    }];
  }).filter((tag) => tag.endSeconds > tag.startSeconds).slice(0, 12);
}

async function buildHeadlineCardFilter(cards: HeadlineCardInput[], clipDuration: number, profile: typeof renderProfiles[RenderProfileName], workDir: string, fontPath: string | null) {
  const usableCards = cards.filter((card) => card.startSeconds < clipDuration && card.endSeconds > 0);
  if (!usableCards.length) return '';
  const filters: string[] = [];
  for (const [index, card] of usableCards.entries()) {
    const start = Math.max(0, Math.min(clipDuration, card.startSeconds));
    const end = Math.min(clipDuration, Math.max(start + 0.1, card.endSeconds));
    if (end <= start) continue;
    const textPath = join(workDir, `headline-card-${index}.txt`);
    const wrappedText = card.lines?.length ? card.lines.join('\n') : wrapHeadline(card.text, card.widthPercent);
    await writeFile(textPath, wrappedText, 'utf8');
    const padding = card.paddingPx?.horizontal ?? (profile.height >= 1800 ? 18 : 14);
    const fontSize = card.fontSizePx && card.fontSizePx > 0 ? card.fontSizePx : headlineFontSize(profile, card, wrappedText, padding);
    const lineSpacing = Math.round(fontSize * ((card.lineHeight ?? 1.1) - 1));
    const font = fontPath ? `fontfile='${escapeFilterPath(fontPath)}'` : '';
    const style = headlineStyle(card.color, card.backgroundColor, card.textColor);
    const progress = transitionProgressExpression(start, end, card.transitionSeconds, false);
    const scale = `(0.86+0.14*${progress})`;
    const boxWidth = `(w*${(card.widthPercent / 100).toFixed(3)})*${scale}`;
    const boxHeight = `(h*${(card.heightPercent / 100).toFixed(3)})*${scale}`;
    const boxX = `(w*${(card.xPercent / 100).toFixed(3)})-(${boxWidth})/2`;
    const boxY = `(h*${(card.yPercent / 100).toFixed(3)})-(${boxHeight})/2`;
    const textX = `(w*${(card.xPercent / 100).toFixed(3)})-text_w/2`;
    const textY = `(h*${(card.yPercent / 100).toFixed(3)})-text_h/2`;
    const enable = `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
    const box = `drawbox=x='${boxX}':y='${boxY}':w='${boxWidth}':h='${boxHeight}':color=${style.background}@0.95:t=fill:${enable}`;
    const text = ['drawtext', font, `textfile='${escapeFilterPath(textPath)}'`, `fontcolor=${style.text}`, `fontsize='${fontSize}*${scale}'`, `line_spacing=${lineSpacing}`, `x='${textX}'`, `y='${textY}'`, `alpha='${progress}'`, enable].filter(Boolean).join(':');
    // The editor's geometry is a real card rectangle. Keep the same rectangle
    // and center the measured text inside it instead of sizing the box from
    // the text itself.
    filters.push(box, text);
  }
  return filters.length ? `,${filters.join(',')}` : '';
}

async function buildNameTagFilter(tags: NameTagInput[], clipDuration: number, profile: typeof renderProfiles[RenderProfileName], workDir: string, fontPath: string | null) {
  const usableTags = tags.filter((tag) => tag.startSeconds < clipDuration && tag.endSeconds > 0);
  if (!usableTags.length) return '';
  const padding = profile.height >= 1800 ? 28 : 18;
  const filters: string[] = [];
  for (const [index, tag] of usableTags.entries()) {
    const start = Math.max(0, Math.min(clipDuration, tag.startSeconds));
    const end = Math.min(clipDuration, Math.max(start + 0.1, tag.endSeconds));
    if (end <= start) continue;
    const namePath = join(workDir, `nametag-name-${index}.txt`);
    const titlePath = join(workDir, `nametag-title-${index}.txt`);
    await writeFile(namePath, tag.name || 'Name', 'utf8');
    await writeFile(titlePath, tag.title || 'Title', 'utf8');
    const style = headlineStyle(tag.color, tag.backgroundColor, tag.textColor);
    const nameSize = tag.fontSizePx && tag.fontSizePx > 0
      ? tag.fontSizePx
      : Math.max(14, Math.min(profile.height >= 1800 ? 42 : 32, profile.width * tag.widthPercent / 100 / Math.max(8, (tag.name || 'Name').length * 0.58), profile.height * tag.heightPercent / 100 / 3.1) * 0.8);
    const titleSize = Math.max(9, Math.round(nameSize * 0.58));
    const font = fontPath ? `fontfile='${escapeFilterPath(fontPath)}'` : '';
    const progress = transitionProgressExpression(start, end, tag.transitionSeconds);
    const scale = `(0.86+0.14*${progress})`;
    const scaledWidth = `(iw*${(tag.widthPercent / 100).toFixed(3)})*${scale}`;
    const scaledHeight = `(ih*${(tag.heightPercent / 100).toFixed(3)})*${scale}`;
    const boxX = `(iw*${(tag.xPercent / 100).toFixed(3)})-(${scaledWidth})/2`;
    const boxY = `(ih*${(tag.yPercent / 100).toFixed(3)})-(${scaledHeight})/2`;
    const textX = `(${boxX})+(${padding}*${scale})`;
    const textY = `(${boxY})+(${padding}*${scale})`;
    const enable = `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
    const box = `drawbox=x='${boxX}':y='${boxY}':w='${scaledWidth}':h='${scaledHeight}':color=${style.background}@0.95:t=fill:${enable}`;
    const name = [`drawtext`, font, `textfile='${escapeFilterPath(namePath)}'`, `fontcolor=${style.text}`, `fontsize='${nameSize.toFixed(1)}*${scale}'`, `x='${textX}'`, `y='${textY}'`, `alpha='${progress}'`, enable].filter(Boolean).join(':');
    const title = [`drawtext`, font, `textfile='${escapeFilterPath(titlePath)}'`, `fontcolor=${style.text}`, `fontsize='${titleSize}*${scale}'`, `x='${textX}'`, `y='(${textY})+${nameSize.toFixed(1)}*${scale}*1.15`, `alpha='${progress}'`, enable].filter(Boolean).join(':');
    filters.push(box, name, title);
  }
  return filters.length ? `,${filters.join(',')}` : '';
}

function headlineStyle(color: string, backgroundOverride?: string, textOverride?: string) {
  const mapped = ({
    navy: { background: '0x17243B', text: 'white' },
    black: { background: '0x101010', text: 'white' },
    purple: { background: '0x5646C8', text: 'white' },
    blue: { background: '0x2768B5', text: 'white' },
    green: { background: '0x2E7D66', text: 'white' },
    red: { background: '0xB44A45', text: 'white' },
    white: { background: '0xFFFFFF', text: 'black' },
  } as Record<string, { background: string; text: string }>)[color] ?? { background: '0x17243B', text: 'white' };
  return {
    background: ffmpegColor(backgroundOverride, mapped.background),
    text: ffmpegColor(textOverride, mapped.text),
  };
}

function ffmpegColor(value: string | undefined, fallback: string) {
  if (!value?.trim()) return fallback;
  const normalized = value.trim().replace(/^#/, '');
  const hex = normalized.length === 3
    ? normalized.split('').map((part) => `${part}${part}`).join('')
    : normalized;
  return /^[0-9a-f]{6}$/i.test(hex) ? `0x${hex.toUpperCase()}` : fallback;
}

function clampRange(value: unknown, min: number, max: number, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
}

function boundedOverlayGeometry(
  x: unknown,
  y: unknown,
  width: unknown,
  height: unknown,
  defaults: { x: number; y: number; width: number; height: number },
  limits: { minWidth: number; maxWidth: number; minHeight: number; maxHeight: number },
) {
  const widthPercent = clampRange(width, limits.minWidth, limits.maxWidth, defaults.width);
  const heightPercent = clampRange(height, limits.minHeight, limits.maxHeight, defaults.height);
  return {
    xPercent: clampRange(x, widthPercent / 2, 100 - widthPercent / 2, defaults.x),
    yPercent: clampRange(y, heightPercent / 2, 100 - heightPercent / 2, defaults.y),
    widthPercent,
    heightPercent,
  };
}

function transitionProgressExpression(start: number, end: number, transitionSeconds: number, includeEntrance = true) {
  const transition = Math.max(0.05, Math.min(2, Math.min(transitionSeconds, (end - start) / 2)));
  const startValue = start.toFixed(3);
  const endValue = end.toFixed(3);
  if (!includeEntrance) return `clip((${endValue}-t)/${transition.toFixed(3)},0,1)`;
  // `clip` and `min` keep this expression valid in drawtext/drawbox while
  // producing one bounded progress value for both the entrance and exit.
  return `min(clip((t-${startValue})/${transition.toFixed(3)},0,1),clip((${endValue}-t)/${transition.toFixed(3)},0,1))`;
}

function headlineFontSize(profile: typeof renderProfiles[RenderProfileName], card: HeadlineCardInput, wrappedText: string, padding: number) {
  const width = Math.max(1, profile.width * card.widthPercent / 100 - padding * 2);
  const height = Math.max(1, profile.height * card.heightPercent / 100 - padding * 2);
  const lines = wrappedText.split('\n').length;
  const longestLine = Math.max(1, ...wrappedText.split('\n').map((line) => line.length));
  const widthLimited = width / (longestLine * 0.58);
  const heightLimited = height / (lines * 1.24);
  const base = profile.height >= 1800 ? 56 : 48;
  return Math.max(10, Math.min(base, widthLimited, heightLimited));
}

function wrapHeadline(text: string, widthPercent = 40) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const maxCharacters = Math.max(12, Math.min(42, Math.round(30 * (widthPercent / 40))));
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && `${line} ${word}`.length > maxCharacters) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

export function logoOverlayPosition(profile: typeof renderProfiles[RenderProfileName], position: LogoPosition, anchorPercent?: { x: number; y: number }) {
  if (anchorPercent) {
    return {
      x: `((main_w-overlay_w)*${anchorPercent.x}/100)`,
      y: `((main_h-overlay_h)*${anchorPercent.y}/100)`,
    };
  }
  const x = position.endsWith('left') ? String(profile.marginX) : position.endsWith('right') ? `main_w-overlay_w-${profile.marginX}` : '(main_w-overlay_w)/2';
  const y = position.startsWith('top') ? String(profile.safeTop) : position.startsWith('bottom') ? `main_h-overlay_h-${profile.safeBottom}` : '(main_h-overlay_h)/2';
  return { x, y };
}

export function baseVideoFilter(profile: typeof renderProfiles[RenderProfileName], fitMode: RenderFitMode, background: RenderBackground = 'dark_blue', reframe?: VideoReframe) {
  if (fitMode === 'contain' && background === 'blurred') {
    return `split=2[blur_source][video_source];[blur_source]scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase,crop=${profile.width}:${profile.height},boxblur=20:2[blurred];[video_source]scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease[video];[blurred][video]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1`;
  }
  if (fitMode === 'contain') {
    const color = background === 'black' ? '0x000000' : background === 'white' ? '0xFFFFFF' : '0x101624';
    return `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2:color=${color},setsar=1`;
  }
  const normalizedReframe = reframe ?? { x: 50, y: 50, scale: 1 };
  if (normalizedReframe.x === 50 && normalizedReframe.y === 50 && normalizedReframe.scale === 1) {
    return `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase,crop=${profile.width}:${profile.height},setsar=1`;
  }
  const xPercent = (normalizedReframe.x / 100).toFixed(4);
  const yPercent = (normalizedReframe.y / 100).toFixed(4);
  const scale = normalizedReframe.scale.toFixed(4);
  const color = background === 'black' ? '0x000000' : background === 'white' ? '0xFFFFFF' : '0x101624';
  return [
    `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase`,
    `scale=iw*${scale}:ih*${scale}`,
    `crop=min(iw\\,${profile.width}):min(ih\\,${profile.height}):max(0\\,${xPercent}*(iw-${profile.width})):max(0\\,${yPercent}*(ih-${profile.height}))`,
    `pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2:color=${color}`,
    'setsar=1',
  ].join(',');
}

function cleanCaptionText(value: string) {
  return value.replace(/(?:&gt;|>)\s*(?:&gt;|>)/gi, ' ').replace(/\s+/g, ' ').trim();
}

function readTranscriptEdits(socialCopy: Record<string, unknown>): TranscriptEdits {
  if (!socialCopy.transcriptEdits || typeof socialCopy.transcriptEdits !== 'object' || Array.isArray(socialCopy.transcriptEdits)) return {};
  return Object.fromEntries(Object.entries(socialCopy.transcriptEdits).filter(([, value]) => typeof value === 'string'));
}

function readSubtitlePosition(socialCopy: Record<string, unknown>): SubtitlePosition {
  if (!socialCopy.subtitlePosition || typeof socialCopy.subtitlePosition !== 'object' || Array.isArray(socialCopy.subtitlePosition)) return { x: 50, y: 84 };
  const position = socialCopy.subtitlePosition as Record<string, unknown>;
  return {
    x: clampRange(position.x, 10, 90, 50),
    y: clampRange(position.y, 8, 92, 84),
  };
}

/**
 * Reproduces the editor's word timing and six-word/34-character line grouping.
 * The segment index is intentionally based on the complete transcript so saved
 * editor edits continue to address the same words when a clip starts mid-video.
 */
export function buildEditorCaptionEvents(segments: CaptionSegment[], clipStart: number, clipEnd: number, transcriptEdits: TranscriptEdits = {}): CaptionEvent[] {
  const words: CaptionWord[] = [];
  segments.forEach((segment, segmentIndex) => {
    const sourceWords = cleanCaptionText(segment.text).split(/\s+/).filter(Boolean);
    if (!sourceWords.length) return;
    const segmentStart = Number(segment.start_seconds);
    const segmentEnd = Number(segment.end_seconds);
    const duration = Math.max(0.1, segmentEnd - segmentStart);
    const weights = sourceWords.map((word) => Math.max(1, word.replace(/[^a-zA-Z0-9']/g, '').length));
    const totalWeight = weights.reduce((total, weight) => total + weight, 0);
    let elapsedWeight = 0;
    sourceWords.forEach((sourceWord, wordIndex) => {
      const rawStartSeconds = segmentStart + (elapsedWeight / totalWeight) * duration;
      elapsedWeight += weights[wordIndex];
      const rawEndSeconds = segmentStart + (elapsedWeight / totalWeight) * duration;
      if (rawEndSeconds <= clipStart || rawStartSeconds >= clipEnd) return;
      const editKey = `${segmentIndex}-${wordIndex}`;
      const text = cleanCaptionText(Object.prototype.hasOwnProperty.call(transcriptEdits, editKey) ? transcriptEdits[editKey] : sourceWord);
      words.push({
        startSeconds: Math.max(clipStart, rawStartSeconds) - clipStart,
        endSeconds: Math.min(clipEnd, rawEndSeconds) - clipStart,
        text,
      });
    });
  });

  const events: CaptionEvent[] = [];
  let line: CaptionWord[] = [];
  let characterCount = 0;
  const flush = () => {
    const visibleWords = line.filter((word) => word.text);
    if (visibleWords.length) {
      events.push({
        startSeconds: visibleWords[0].startSeconds,
        endSeconds: visibleWords[visibleWords.length - 1].endSeconds,
        text: visibleWords.map((word) => word.text).join(' '),
        words: visibleWords,
      });
    }
    line = [];
    characterCount = 0;
  };

  for (const word of words) {
    const nextCount = characterCount + word.text.length + (line.length ? 1 : 0);
    if (line.length && (nextCount > 34 || line.length >= 6)) flush();
    line.push(word);
    characterCount += word.text.length + (line.length > 1 ? 1 : 0);
  }
  flush();
  return events;
}

export function buildSrtFromEvents(events: CaptionEvent[]) {
  return events.map((event, index) => `${index + 1}\n${formatSrtTime(event.startSeconds)} --> ${formatSrtTime(event.endSeconds)}\n${event.text}\n`).join('\n');
}

export function buildSrt(segments: CaptionSegment[], clipStart: number, clipEnd: number, transcriptEdits: TranscriptEdits = {}) {
  return buildSrtFromEvents(buildEditorCaptionEvents(segments, clipStart, clipEnd, transcriptEdits));
}

function assInlineColor(value: unknown, fallback: string) {
  return `${assColor(value, fallback)}&`;
}

function assWordColorText(words: CaptionWord[], time: number, primaryColor: string, activeColor: string) {
  const activeIndex = words.findIndex((word) => time >= word.startSeconds && time < word.endSeconds);
  return words.map((word, index) => {
    const color = index === activeIndex ? activeColor : primaryColor;
    return `{\\1c${color}}${word.text.replace(/[\\{}]/g, '')}`;
  }).join(' ');
}

/**
 * ASS karaoke tags are renderer-dependent: some libass builds leave the
 * completed syllables in the secondary color, while the editor only colors
 * the word currently being spoken. Emit one short event for each word-time
 * interval so FFmpeg/libass and Chromium use the same single-word treatment.
 */
function assActiveWordDialogues(event: CaptionEvent, x: number, y: number, primaryColor: string, activeColor: string) {
  const boundaries = [...new Set([
    event.startSeconds,
    event.endSeconds,
    ...event.words.flatMap((word) => [word.startSeconds, word.endSeconds]),
  ].filter((value) => Number.isFinite(value)).map((value) => Number(value.toFixed(3))))].sort((left, right) => left - right);
  return boundaries.slice(0, -1).flatMap((start, index) => {
    const end = boundaries[index + 1];
    if (end <= start) return [];
    const text = assWordColorText(event.words, (start + end) / 2, primaryColor, activeColor);
    return text ? [`Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,{\\an5\\pos(${x},${y})}${text}\n`] : [];
  });
}

export function buildAssFromEvents(events: CaptionEvent[], profile: typeof renderProfiles[RenderProfileName], fontName: string, position: SubtitlePosition = { x: 50, y: 84 }, style: CaptionStyle = {}) {
  const safeFont = fontName.replace(/[,{}]/g, '');
  const fontSize = clampRange(style.fontSizePx, 5, 96, 22);
  const primaryColor = assColor(style.color, '&H00FFFFFF');
  const secondaryColor = assColor(style.activeColor, '&H00E36B3B');
  const primaryInlineColor = assInlineColor(style.color, '&H00FFFFFF');
  const activeInlineColor = assInlineColor(style.activeColor, '&H00E36B3B');
  const x = Math.round(profile.width * position.x / 100);
  const y = Math.round(profile.height * position.y / 100);
  // BorderStyle 1 with Outline 0 keeps the caption background transparent.
  // The previous BorderStyle 1/Outline 2/Shadow 2 combination was interpreted
  // by libass as a dark caption box, unlike the editor's transparent text.
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${profile.width}\nPlayResY: ${profile.height}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${safeFont},${fontSize},${primaryColor},${secondaryColor},&HFF000000,&HFF000000,1,0,0,0,100,100,0,0,1,0,2,5,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const dialogue = events.flatMap((event) => assActiveWordDialogues(event, x, y, primaryInlineColor, activeInlineColor)).join('');
  return header + dialogue;
}

function assColor(value: unknown, fallback: string) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return fallback;
  const red = normalized.slice(0, 2);
  const green = normalized.slice(2, 4);
  const blue = normalized.slice(4, 6);
  return `&H00${blue}${green}${red}`.toUpperCase();
}

export function buildAss(segments: CaptionSegment[], clipStart: number, clipEnd: number, profile: typeof renderProfiles[RenderProfileName], fontName: string, transcriptEdits: TranscriptEdits = {}, position: SubtitlePosition = { x: 50, y: 84 }, style: CaptionStyle = {}) {
  return buildAssFromEvents(buildEditorCaptionEvents(segments, clipStart, clipEnd, transcriptEdits), profile, fontName, position, style);
}

export function formatSrtTime(seconds: number) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(milliseconds % 1000).padStart(3, '0')}`;
}

function formatAssTime(seconds: number) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

function escapeFilterPath(path: string) {
  return path.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function frameRate(value: string | undefined) {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return Math.abs(numerator / denominator - 30) < 0.01 ? 30 : numerator / denominator;
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

class LeaseLostError extends Error {
  constructor(renderId: string) {
    super(`Render lease was lost before completion: ${renderId}`);
    this.name = 'LeaseLostError';
  }
}

async function assertFile(path: string, label: string) {
  try { await execFile('test', ['-f', path]); } catch { throw new Error(`${label} does not point to a readable file: ${path}`); }
}

function runCommand(command: string, args: string[]) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`)));
  });
}
