import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { LocalAssetStore } from '@clipper/storage';

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
};

interface CaptionSegment {
  start_seconds: string | number;
  end_seconds: string | number;
  text: string;
}

export class RenderProcessor {
  private readonly ffmpegBinary: string;
  private readonly brandLogoPath: string;
  private readonly brandFontPath: string | null;
  private readonly brandFontName: string;

  constructor(
    private readonly db: pg.Pool,
    private readonly store: LocalAssetStore,
    private readonly leaseSeconds = 60,
    options: { ffmpegBinary?: string; brandLogoPath?: string; brandFontPath?: string; brandFontName?: string } = {},
  ) {
    this.ffmpegBinary = options.ffmpegBinary ?? process.env.FFMPEG_BIN ?? 'ffmpeg';
    this.brandLogoPath = options.brandLogoPath ?? process.env.BRAND_LOGO_PATH ?? resolve(process.cwd(), 'assets/brand/axios-logo.png');
    this.brandFontPath = options.brandFontPath ?? process.env.BRAND_FONT_PATH ?? null;
    this.brandFontName = options.brandFontName ?? process.env.BRAND_FONT_NAME ?? (this.brandFontPath ? 'NB International Pro' : 'DejaVu Sans');
  }

  async recoverExpired() {
    return (await this.db.query("UPDATE clip_renders SET status='queued', claimed_at=NULL, lease_expires_at=NULL, updated_at=now() WHERE status='processing' AND lease_expires_at < now() RETURNING id")).rowCount ?? 0;
  }

  async runOnce() {
    await this.recoverExpired();
    const claim = await this.db.query("WITH selected_render AS (SELECT id FROM clip_renders WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE clip_renders AS r SET status='processing', attempts=r.attempts+1, claimed_at=now(), lease_expires_at=now() + ($1 * interval '1 second'), progress=5, updated_at=now() FROM selected_render AS s WHERE r.id=s.id RETURNING r.id", [this.leaseSeconds]);
    if (!claim.rowCount) return null;
    const renderId = claim.rows[0].id as string;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      heartbeat = setInterval(() => {
        void this.db.query("UPDATE clip_renders SET lease_expires_at=now() + ($2 * interval '1 second'), updated_at=now() WHERE id=$1 AND status='processing'", [renderId, this.leaseSeconds]).catch(() => undefined);
      }, Math.max(5_000, Math.floor(this.leaseSeconds * 500)));
      const job = await this.loadRenderJob(renderId);
      const profile = renderProfiles[job.profile];
      const startSeconds = Number(job.edited_start_seconds ?? job.start_seconds);
      const endSeconds = Number(job.edited_end_seconds ?? job.end_seconds);
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) throw new Error('Render window must have a positive duration');
      this.store.getPath(job.source_storage_key);
      const logoPath = job.include_logo ? await this.logoPathFor(job.logo_asset_id) : null;
      if (job.include_logo && logoPath) await assertFile(logoPath, job.logo_asset_id ? 'selected brand asset' : 'BRAND_LOGO_PATH');
      if (job.caption_mode === 'burned' && this.brandFontPath) await assertFile(this.brandFontPath, 'BRAND_FONT_PATH');

      await this.updateProgress(renderId, 20);
      const workDir = join(process.env.TMPDIR ?? '/tmp', 'clipper-renders', renderId);
      await mkdir(workDir, { recursive: true });
      const captions = job.caption_mode === 'none' ? { srt: null, ass: null, count: 0 } : await this.prepareCaptions(job.transcript_id, startSeconds, endSeconds, profile, workDir);
      const headlineCards = readHeadlineCards(job.social_copy);
      const nameTags = readNameTags(job.social_copy);
      await this.updateProgress(renderId, 35);
      const outputPath = join(workDir, 'clip.mp4');
      await this.renderVideo(job, profile, job.fit_mode, job.background, job.logo_position, logoPath, startSeconds, endSeconds, job.caption_mode === 'burned' ? captions.ass : null, headlineCards, nameTags, workDir, outputPath);
      const thumbnailPath = join(workDir, 'thumbnail.jpg');
      await this.renderThumbnail(job, profile, job.fit_mode, job.background, startSeconds, thumbnailPath);
      await this.updateProgress(renderId, 70);

      const videoAsset = await this.storeFileAsset(job.source_id, `renders/${renderId}/clip.mp4`, outputPath, 'video/mp4', 'render');
      const thumbnailAsset = await this.storeFileAsset(job.source_id, `renders/${renderId}/thumbnail.jpg`, thumbnailPath, 'image/jpeg', 'render');
      const captionAsset = captions.srt ? await this.storeBufferAsset(job.source_id, `renders/${renderId}/captions.srt`, await readFile(captions.srt), 'application/x-subrip', 'transcript') : null;
      const manifest = {
        schema: 'axios.clip.render.v1',
        brandGuidelines: 'Axios Brand Guidelines v1.2 Agency Onboarding',
        renderer: 'ffmpeg',
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
      const manifestAsset = await this.storeBufferAsset(job.source_id, `renders/${renderId}/render-manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json', 'render');
      await this.updateProgress(renderId, 90);
      await this.db.query("UPDATE clip_renders SET status='completed', progress=100, completed_at=now(), lease_expires_at=NULL, asset_id=$2, thumbnail_asset_id=$3, caption_asset_id=$4, manifest_asset_id=$5, render_manifest=$6, error=NULL, updated_at=now() WHERE id=$1", [renderId, videoAsset.id, thumbnailAsset.id, captionAsset?.id ?? null, manifestAsset.id, JSON.stringify(manifest)]);
      await rm(workDir, { recursive: true, force: true });
      return renderId;
    } catch (error) {
      await this.db.query("UPDATE clip_renders SET status='failed', error=$2, lease_expires_at=NULL, updated_at=now() WHERE id=$1", [renderId, error instanceof Error ? error.message : 'render failed']);
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  private async loadRenderJob(renderId: string) {
    const result = await this.db.query("SELECT r.id, r.candidate_id, r.profile, r.fit_mode, r.background, r.logo_position, r.logo_asset_id, r.caption_mode, r.include_logo, c.job_id, c.transcript_id, c.start_seconds, c.end_seconds, c.edited_start_seconds, c.edited_end_seconds, c.social_copy, j.source_id, a.storage_key AS source_storage_key FROM clip_renders r JOIN clip_candidates c ON c.id=r.candidate_id JOIN processing_jobs j ON j.id=c.job_id JOIN assets a ON a.source_id=j.source_id AND a.role='source' WHERE r.id=$1 ORDER BY a.created_at DESC LIMIT 1", [renderId]);
    if (!result.rowCount) throw new Error(`Render ${renderId} has no source asset`);
    return result.rows[0] as RenderJobRow;
  }

  private async prepareCaptions(transcriptId: string | null, clipStart: number, clipEnd: number, profile: typeof renderProfiles[RenderProfileName], workDir: string) {
    if (!transcriptId) return { srt: null, ass: null, count: 0 };
    const result = await this.db.query('SELECT start_seconds,end_seconds,text FROM transcript_segments WHERE transcript_id=$1 AND end_seconds > $2 AND start_seconds < $3 ORDER BY start_seconds', [transcriptId, clipStart, clipEnd]);
    const segments = result.rows as CaptionSegment[];
    if (!segments.length) return { srt: null, ass: null, count: 0 };
    const srtPath = join(workDir, 'captions.srt');
    const assPath = join(workDir, 'captions.ass');
    await writeFile(srtPath, buildSrt(segments, clipStart, clipEnd));
    await writeFile(assPath, buildAss(segments, clipStart, clipEnd, profile, this.brandFontName));
    return { srt: srtPath, ass: assPath, count: segments.length };
  }

  private async logoPathFor(logoAssetId: string | null) {
    if (!logoAssetId) return this.brandLogoPath;
    const result = await this.db.query('SELECT a.storage_key FROM brand_assets b JOIN assets a ON a.id=b.asset_id WHERE b.id=$1 AND b.active=true', [logoAssetId]);
    if (!result.rowCount) throw new Error(`Brand asset ${logoAssetId} was not found or is inactive`);
    return this.store.getPath(result.rows[0].storage_key as string);
  }

  private async renderVideo(job: RenderJobRow, profile: typeof renderProfiles[RenderProfileName], fitMode: RenderFitMode, background: RenderBackground, logoPosition: LogoPosition, logoPath: string | null, startSeconds: number, endSeconds: number, assPath: string | null, headlineCards: HeadlineCardInput[], nameTags: NameTagInput[], workDir: string, outputPath: string) {
    const fontsDir = this.brandFontPath ? `:fontsdir=${escapeFilterPath(dirname(this.brandFontPath))}` : '';
    const headlineFilter = await buildHeadlineCardFilter(headlineCards, endSeconds - startSeconds, profile, workDir, this.brandFontPath);
    const nameTagFilter = await buildNameTagFilter(nameTags, endSeconds - startSeconds, profile, workDir, this.brandFontPath);
    const baseFilter = `${baseVideoFilter(profile, fitMode, background)}${headlineFilter}${nameTagFilter}${assPath ? `,subtitles=${escapeFilterPath(assPath)}${fontsDir}` : ''}`;
    const duration = (endSeconds - startSeconds).toFixed(3);
    const args = ['-y', '-ss', startSeconds.toFixed(3), '-i', this.store.getPath(job.source_storage_key)];
    if (job.include_logo && logoPath) {
      const position = logoOverlayPosition(profile, logoPosition);
      args.push('-loop', '1', '-i', logoPath, '-filter_complex', `[0:v]${baseFilter}[base];[1:v]scale=-1:${profile.logoHeight}[logo];[base][logo]overlay=${position.x}:${position.y}:format=auto[v]`, '-map', '[v]');
    } else {
      args.push('-vf', baseFilter, '-map', '0:v:0');
    }
    args.push('-map', '0:a?', '-t', duration, '-r', '30', '-c:v', 'libx264', '-preset', process.env.FFMPEG_PRESET ?? 'veryfast', '-crf', process.env.FFMPEG_CRF ?? '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-movflags', '+faststart', outputPath);
    await runCommand(this.ffmpegBinary, args);
  }

  private async renderThumbnail(job: RenderJobRow, profile: typeof renderProfiles[RenderProfileName], fitMode: RenderFitMode, background: RenderBackground, startSeconds: number, outputPath: string) {
    await runCommand(this.ffmpegBinary, ['-y', '-ss', startSeconds.toFixed(3), '-i', this.store.getPath(job.source_storage_key), '-frames:v', '1', '-vf', baseVideoFilter(profile, fitMode, background), '-q:v', '2', outputPath]);
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
};

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
  const boxBorderWidth = profile.height >= 1800 ? 22 : 16;
  const filters: string[] = [];
  for (const [index, card] of usableCards.entries()) {
    const start = Math.max(0, Math.min(clipDuration, card.startSeconds));
    const end = Math.min(clipDuration, Math.max(start + 0.1, card.endSeconds));
    if (end <= start) continue;
    const textPath = join(workDir, `headline-card-${index}.txt`);
    const wrappedText = wrapHeadline(card.text, card.widthPercent);
    await writeFile(textPath, wrappedText, 'utf8');
    const fontSize = headlineFontSize(profile, card, wrappedText, boxBorderWidth);
    const font = fontPath ? `fontfile='${escapeFilterPath(fontPath)}'` : '';
    const style = headlineStyle(card.color);
    const progress = transitionProgressExpression(start, end, card.transitionSeconds, false);
    const scale = `(0.86+0.14*${progress})`;
    const x = `(w*${(card.xPercent / 100).toFixed(3)})-text_w/2`;
    const y = `(h*${(card.yPercent / 100).toFixed(3)})-text_h/2`;
    const options = [font, `textfile='${escapeFilterPath(textPath)}'`, `fontcolor=${style.text}`, `fontsize='${fontSize}*${scale}'`, 'box=1', `boxcolor=${style.background}@0.95`, `boxborderw=${boxBorderWidth}`, `x='${x}'`, `y='${y}'`, `alpha='${progress}'`, `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`].filter(Boolean).join(':');
    filters.push(`drawtext=${options}`);
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
    const style = headlineStyle(tag.color);
    const x = `(w*${(tag.xPercent / 100).toFixed(3)})-(w*${(tag.widthPercent / 100).toFixed(3)})/2`;
    const y = `(h*${(tag.yPercent / 100).toFixed(3)})-(h*${(tag.heightPercent / 100).toFixed(3)})/2`;
    const nameSize = Math.max(14, Math.min(profile.height >= 1800 ? 42 : 32, profile.width * tag.widthPercent / 100 / Math.max(8, (tag.name || 'Name').length * 0.58), profile.height * tag.heightPercent / 100 / 3.1) * 0.8);
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

function headlineStyle(color: string) {
  return ({
    navy: { background: '0x17243B', text: 'white' },
    black: { background: '0x101010', text: 'white' },
    purple: { background: '0x5646C8', text: 'white' },
    blue: { background: '0x2768B5', text: 'white' },
    green: { background: '0x2E7D66', text: 'white' },
    red: { background: '0xB44A45', text: 'white' },
    white: { background: '0xFFFFFF', text: 'black' },
  } as Record<string, { background: string; text: string }>)[color] ?? { background: '0x17243B', text: 'white' };
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

function headlineFontSize(profile: typeof renderProfiles[RenderProfileName], card: HeadlineCardInput, wrappedText: string, boxBorderWidth: number) {
  const width = Math.max(1, profile.width * card.widthPercent / 100 - boxBorderWidth * 2);
  const height = Math.max(1, profile.height * card.heightPercent / 100 - boxBorderWidth * 2);
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

export function logoOverlayPosition(profile: typeof renderProfiles[RenderProfileName], position: LogoPosition) {
  const x = position.endsWith('left') ? String(profile.marginX) : position.endsWith('right') ? `main_w-overlay_w-${profile.marginX}` : '(main_w-overlay_w)/2';
  const y = position.startsWith('top') ? String(profile.safeTop) : position.startsWith('bottom') ? `main_h-overlay_h-${profile.safeBottom}` : '(main_h-overlay_h)/2';
  return { x, y };
}

function baseVideoFilter(profile: typeof renderProfiles[RenderProfileName], fitMode: RenderFitMode, background: RenderBackground = 'dark_blue') {
  if (fitMode === 'contain' && background === 'blurred') {
    return `split=2[blur_source][video_source];[blur_source]scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase,crop=${profile.width}:${profile.height},boxblur=20:2[blurred];[video_source]scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease[video];[blurred][video]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1`;
  }
  if (fitMode === 'contain') {
    const color = background === 'black' ? '0x000000' : background === 'white' ? '0xFFFFFF' : '0x101624';
    return `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2:color=${color},setsar=1`;
  }
  return `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase,crop=${profile.width}:${profile.height},setsar=1`;
}

export function buildSrt(segments: CaptionSegment[], clipStart: number, clipEnd: number) {
  return segments.map((segment, index) => {
    const start = Math.max(0, Number(segment.start_seconds) - clipStart);
    const end = Math.min(clipEnd, Number(segment.end_seconds)) - clipStart;
    return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${wrapCaption(segment.text)}\n`;
  }).join('\n');
}

export function buildAss(segments: CaptionSegment[], clipStart: number, clipEnd: number, profile: typeof renderProfiles[RenderProfileName], fontName: string) {
  const safeFont = fontName.replace(/[,{}]/g, '');
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${profile.width}\nPlayResY: ${profile.height}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${safeFont},48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,0,0,0,0,100,100,0,0,1,3,0,2,${profile.marginX},${profile.marginX},${profile.captionMarginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const events = segments.map((segment) => {
    const start = Math.max(0, Number(segment.start_seconds) - clipStart);
    const end = Math.min(clipEnd, Number(segment.end_seconds)) - clipStart;
    return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${wrapCaption(segment.text).replace(/[{}]/g, '').replace(/\n/g, '\\N')}\n`;
  }).join('');
  return header + events;
}

function wrapCaption(text: string) {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && `${line} ${word}`.length > 34) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 2).join('\n');
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
