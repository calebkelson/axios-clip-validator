import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import type { AssetStore } from '@clipper/storage';

export type ThumbnailBox = { x: number; y: number; width: number; height: number };

export type ThumbnailSegmentationInput = {
  sourceFramePath: string;
  outputPath: string;
  positiveBox: ThumbnailBox | null;
  negativeBoxes: ThumbnailBox[];
  protectedBoxes: ThumbnailBox[];
};

export interface ThumbnailSegmentationProvider {
  readonly name: 'sam3' | 'u2netp';
  segment(input: ThumbnailSegmentationInput): Promise<void>;
}
export type ThumbnailCommandRunner = (command: string, args: string[]) => Promise<void>;

export class Sam3UnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'Sam3UnavailableError';
  }
}

/** HTTP client for the local SAM3 sidecar. The sidecar reads the worker's
 * frame path and returns paths to the generated subject and mask files. */
export class Sam3SidecarClient implements ThumbnailSegmentationProvider {
  readonly name = 'sam3' as const;

  constructor(
    private readonly baseUrl = process.env.SAM3_SIDECAR_URL,
    private readonly timeoutMs = Number(process.env.SAM3_TIMEOUT_MS ?? 120_000),
  ) {}

  async segment(input: ThumbnailSegmentationInput) {
    if (!this.baseUrl) throw new Sam3UnavailableError('SAM3_SIDECAR_URL is not configured');
    if (!input.positiveBox) throw new Error('SAM3 segmentation requires a positive box');
    const body = JSON.stringify({
      framePath: input.sourceFramePath,
      positiveBox: input.positiveBox,
      negativeBoxes: input.negativeBoxes,
      protectedBoxes: input.protectedBoxes,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(sidecarEndpoint(this.baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal });
      } catch (error) {
        throw new Sam3UnavailableError('SAM3 sidecar is unavailable', { cause: error });
      }
      if (!response.ok) {
        const details = (await response.text()).slice(0, 500);
        if (response.status === 404 || response.status === 408 || response.status === 429 || response.status >= 500) {
          throw new Sam3UnavailableError(`SAM3 sidecar returned HTTP ${response.status}: ${details}`);
        }
        throw new Error(`SAM3 segmentation failed with HTTP ${response.status}: ${details}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.startsWith('image/')) {
        await writeFile(input.outputPath, new Uint8Array(await response.arrayBuffer()));
        return;
      }
      const result = await response.json() as { subjectPath?: string; subjectPngPath?: string; subjectBase64?: string; imageBase64?: string; outputBase64?: string };
      const subjectPath = result.subjectPath ?? result.subjectPngPath;
      if (subjectPath) {
        await writeFile(input.outputPath, await readFile(subjectPath));
        return;
      }
      const encoded = result.subjectBase64 ?? result.imageBase64 ?? result.outputBase64;
      if (!encoded) throw new Error('SAM3 sidecar response did not contain a subject path or segmented image');
      await writeFile(input.outputPath, Buffer.from(encoded.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Local no-prompt fallback using rembg's compact u2netp model. */
export class U2NetpSegmentationProvider implements ThumbnailSegmentationProvider {
  readonly name = 'u2netp' as const;

  constructor(
    private readonly binary = process.env.REMBG_BIN ?? 'rembg',
    private readonly commandRunner: ThumbnailCommandRunner = runCommand,
  ) {}

  async segment(input: ThumbnailSegmentationInput) {
    await this.commandRunner(this.binary, ['i', '-m', 'u2netp', input.sourceFramePath, input.outputPath]);
  }
}

type ThumbnailProjectRow = {
  id: string;
  candidate_id: string;
  source_id: string;
  frame_seconds: number | string;
  source_headline_card_id: string | null;
  brand_asset_id: string | null;
  segmentation_provider: 'sam3' | 'u2netp';
  positive_box: ThumbnailBox | null;
  negative_boxes: ThumbnailBox[];
  protected_boxes: ThumbnailBox[];
  manifest_json: Record<string, unknown> | null;
  source_frame_asset_id: string | null;
  subject_asset_id: string | null;
  preview_asset_id: string | null;
  export_asset_id: string | null;
  source_storage_key: string;
  social_copy: Record<string, unknown>;
};

type StoredThumbnailAsset = { id: string; storage_key: string };

type HeadlineCard = { id: string; text: string; color: string | null };
export type ThumbnailLayoutPreset = 'original' | 'bold_statement' | 'topic_first' | 'quote_hook' | 'data_callout' | 'split_focus' | 'clean_cut' | 'behind_numbers' | 'question' | 'event_stage' | 'minimal_portrait' | 'motion_gradient' | 'framed_insight';
type ThumbnailBackgroundPreset = 'source' | 'dark_blue' | 'black' | 'white' | 'gradient_blue' | 'gradient_cobalt' | 'gradient_royal' | 'gradient_dark' | 'gradient_white_blue';
type ThumbnailTextAlignment = 'left' | 'center' | 'right';
export type ThumbnailComposition = {
  layoutPreset: ThumbnailLayoutPreset;
  subject: { position: { x: number; y: number }; scale: number };
  headline: { sourceCardId: string | null; resolvedText: string; text: string; size: number; alignment: ThumbnailTextAlignment };
  backgroundPreset: ThumbnailBackgroundPreset;
  logo: { brandAssetId: string | null; position: 'top-left' | 'top-center' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right' };
};
type ThumbnailVariant = { layoutPreset: ThumbnailLayoutPreset; label: string; key: string; assetId: string | null };
const THUMBNAIL_VARIANTS: Array<{ layoutPreset: ThumbnailLayoutPreset; label: string }> = [
  { layoutPreset: 'original', label: 'Original frame' },
  { layoutPreset: 'bold_statement', label: 'Bold statement' },
  { layoutPreset: 'topic_first', label: 'Topic first' },
  { layoutPreset: 'quote_hook', label: 'Quote hook' },
  { layoutPreset: 'data_callout', label: 'Data callout' },
  { layoutPreset: 'split_focus', label: 'Split focus' },
  { layoutPreset: 'clean_cut', label: 'Clean cut' },
  { layoutPreset: 'behind_numbers', label: 'Behind the numbers' },
  { layoutPreset: 'question', label: 'The question' },
  { layoutPreset: 'event_stage', label: 'Event / stage' },
  { layoutPreset: 'minimal_portrait', label: 'Minimal portrait' },
  { layoutPreset: 'motion_gradient', label: 'Motion gradient' },
  { layoutPreset: 'framed_insight', label: 'Framed insight' },
];
export const THUMBNAIL_LAYOUT_PRESETS = THUMBNAIL_VARIANTS.map((variant) => variant.layoutPreset) as ThumbnailLayoutPreset[];

export type ThumbnailManifestInput = {
  project: ThumbnailProjectRow;
  provider: 'sam3' | 'u2netp';
  headlineCard: HeadlineCard | null;
  brandAssetId: string | null;
  brandAssetDbId: string | null;
  sourceFrameAssetId: string | null;
  subjectAssetId: string | null;
  previewAssetId: string | null;
  exportAssetId: string | null;
  composition?: ThumbnailComposition;
  variants?: ThumbnailVariant[];
  createdAt?: string;
  width?: number;
  height?: number;
};

export function createThumbnailManifest(input: ThumbnailManifestInput) {
  const projectId = input.project.id;
  const composition = input.composition ?? compositionFromManifest(input.project.manifest_json, input.headlineCard, input.brandAssetId);
  return {
    schema: 'axios.thumbnail.manifest.v1' as const,
    projectId,
    candidateId: input.project.candidate_id,
    sourceId: input.project.source_id,
    frameSeconds: Number(input.project.frame_seconds),
    dimensions: { width: input.width ?? 1280, height: input.height ?? 720 },
    segmentation: {
      provider: input.provider,
      positiveBox: input.project.positive_box ?? null,
      negativeBoxes: Array.isArray(input.project.negative_boxes) ? input.project.negative_boxes : [],
      protectedBoxes: Array.isArray(input.project.protected_boxes) ? input.project.protected_boxes : [],
    },
    headlineCard: input.headlineCard,
    branding: { brandAssetId: input.brandAssetId, assetId: input.brandAssetDbId },
    composition,
    variants: input.variants ?? manifestVariants(input.project.manifest_json),
    assets: {
      sourceFrame: { key: `thumbnails/${projectId}/source-frame.png`, assetId: input.sourceFrameAssetId },
      subject: { key: `thumbnails/${projectId}/subject.png`, assetId: input.subjectAssetId },
      preview: { key: `thumbnails/${projectId}/preview.jpg`, assetId: input.previewAssetId },
      manifest: { key: `thumbnails/${projectId}/thumbnail-manifest.json` },
      export: { key: `thumbnails/${projectId}/export.png`, assetId: input.exportAssetId },
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

function compositionFromManifest(manifest: Record<string, unknown> | null, headlineCard: HeadlineCard | null, brandAssetId: string | null): ThumbnailComposition {
  const raw = manifest?.composition;
  if (raw && typeof raw === 'object') {
    const value = raw as Partial<ThumbnailComposition>;
    if (typeof value.layoutPreset === 'string' && value.subject && value.headline && typeof value.backgroundPreset === 'string' && value.logo) return value as ThumbnailComposition;
  }
  return {
    layoutPreset: 'clean_cut',
    subject: { position: { x: 0.68, y: 0.54 }, scale: 1 },
    headline: { sourceCardId: headlineCard?.id ?? null, resolvedText: headlineText(headlineCard), text: headlineText(headlineCard), size: 64, alignment: 'left' },
    backgroundPreset: 'gradient_blue',
    logo: { brandAssetId, position: 'top-left' },
  };
}

function headlineText(headlineCard: HeadlineCard | null) {
  return headlineCard?.text ?? '';
}

function manifestVariants(manifest: Record<string, unknown> | null): ThumbnailVariant[] {
  const variants = manifest?.variants;
  return Array.isArray(variants) ? variants as ThumbnailVariant[] : [];
}

export function buildExactFrameExtractionArgs(sourcePath: string, frameSeconds: number, outputPath: string) {
  return ['-y', '-i', sourcePath, '-ss', frameSeconds.toFixed(3), '-map', '0:v:0', '-frames:v', '1', '-c:v', 'png', outputPath];
}

export async function segmentThumbnail(
  requestedProvider: 'sam3' | 'u2netp',
  input: ThumbnailSegmentationInput,
  providers: { sam3: ThumbnailSegmentationProvider; u2netp: ThumbnailSegmentationProvider },
) {
  if (requestedProvider === 'u2netp') {
    await providers.u2netp.segment(input);
    return providers.u2netp.name;
  }
  try {
    await providers.sam3.segment(input);
    return providers.sam3.name;
  } catch (error) {
    if (!(error instanceof Sam3UnavailableError)) throw error;
    await providers.u2netp.segment(input);
    return providers.u2netp.name;
  }
}

export class ThumbnailProcessor {
  private readonly ffmpegBinary: string;
  private readonly commandRunner: ThumbnailCommandRunner;
  private readonly sam3: ThumbnailSegmentationProvider;
  private readonly u2netp: ThumbnailSegmentationProvider;
  private readonly width: number;
  private readonly height: number;

  constructor(
    private readonly db: pg.Pool,
    private readonly store: AssetStore,
    private readonly leaseSeconds = 120,
    options: {
      ffmpegBinary?: string;
      commandRunner?: ThumbnailCommandRunner;
      sam3Provider?: ThumbnailSegmentationProvider;
      u2netpProvider?: ThumbnailSegmentationProvider;
      width?: number;
      height?: number;
    } = {},
  ) {
    this.ffmpegBinary = options.ffmpegBinary ?? process.env.FFMPEG_BIN ?? 'ffmpeg';
    this.commandRunner = options.commandRunner ?? runCommand;
    this.sam3 = options.sam3Provider ?? new Sam3SidecarClient();
    this.u2netp = options.u2netpProvider ?? new U2NetpSegmentationProvider(process.env.REMBG_BIN ?? 'rembg', this.commandRunner);
    this.width = options.width ?? Number(process.env.THUMBNAIL_WIDTH ?? 1280);
    this.height = options.height ?? Number(process.env.THUMBNAIL_HEIGHT ?? 720);
  }

  async recoverExpired() {
    const result = await this.db.query(`
      WITH expired AS (
        UPDATE thumbnail_jobs
        SET status='queued', claimed_at=NULL, lease_expires_at=NULL, updated_at=now()
        WHERE status='processing' AND lease_expires_at < now()
        RETURNING thumbnail_project_id
      )
      UPDATE thumbnail_projects AS project
      SET status=CASE WHEN project.status='exporting' THEN 'export_queued' ELSE 'queued' END,
          error=NULL, updated_at=now()
      FROM expired
      WHERE project.id=expired.thumbnail_project_id
      RETURNING project.id
    `);
    return result.rowCount ?? 0;
  }

  async runOnce() {
    await this.recoverExpired();
    const claim = await this.db.query(`
      WITH selected_job AS (
        SELECT job.id, job.thumbnail_project_id, project.status AS project_status
        FROM thumbnail_jobs AS job
        JOIN thumbnail_projects AS project ON project.id=job.thumbnail_project_id
        WHERE job.status='queued' AND project.status IN ('queued', 'export_queued')
        ORDER BY job.created_at
        FOR UPDATE OF job, project SKIP LOCKED
        LIMIT 1
      ), claimed_job AS (
        UPDATE thumbnail_jobs AS job
        SET status='processing', progress=5, attempts=job.attempts+1, claimed_at=now(),
            lease_expires_at=now() + ($1 * interval '1 second'), error=NULL, updated_at=now()
        FROM selected_job
        WHERE job.id=selected_job.id
        RETURNING job.id, job.thumbnail_project_id
      ), claimed_project AS (
        UPDATE thumbnail_projects AS project
        SET status=CASE WHEN selected_job.project_status='export_queued' THEN 'exporting' ELSE 'processing' END,
            error=NULL, updated_at=now()
        FROM selected_job
        WHERE project.id=selected_job.thumbnail_project_id AND project.status=selected_job.project_status
        RETURNING project.id
      )
      SELECT claimed_job.id,claimed_job.thumbnail_project_id,selected_job.project_status
      FROM claimed_job
      JOIN selected_job ON selected_job.id=claimed_job.id
      JOIN claimed_project ON claimed_project.id=claimed_job.thumbnail_project_id
    `, [this.leaseSeconds]);
    if (!claim.rowCount) return null;
    const { id: jobId, thumbnail_project_id: projectId, project_status: projectStatus } = claim.rows[0] as { id: string; thumbnail_project_id: string; project_status: string };
    const operation = projectStatus === 'export_queued' ? 'export' : 'preview';
    const workDir = join(process.env.TMPDIR ?? '/tmp', 'clipper-thumbnails', jobId);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      heartbeat = setInterval(() => { void this.refreshLease(jobId); }, Math.max(5_000, Math.floor(this.leaseSeconds * 333)));
      heartbeat.unref?.();
      await mkdir(workDir, { recursive: true });
      const project = await this.loadProject(projectId);
      if (operation === 'export') await this.processExport(jobId, project, workDir);
      else await this.processPreview(jobId, project, workDir);
      await this.db.query("UPDATE thumbnail_jobs SET status='completed',progress=100,lease_expires_at=NULL,error=NULL,updated_at=now() WHERE id=$1 AND status='processing'", [jobId]);
      return jobId;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'thumbnail processing failed';
      await Promise.all([
        this.db.query("UPDATE thumbnail_jobs SET status='failed',lease_expires_at=NULL,error=$2,updated_at=now() WHERE id=$1 AND status='processing'", [jobId, message]),
        this.db.query("UPDATE thumbnail_projects SET status='failed',error=$2,updated_at=now() WHERE id=$1", [projectId, message]),
      ]);
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async processPreview(jobId: string, project: ThumbnailProjectRow, workDir: string) {
    const sourceFramePath = join(workDir, 'source-frame.png');
    const subjectPath = join(workDir, 'subject.png');
    const previewPath = join(workDir, 'preview.jpg');
    let sourceFrameAssetId = project.source_frame_asset_id;
    let subjectAssetId = project.subject_asset_id;
    if (sourceFrameAssetId) {
      await this.materializeAsset(sourceFrameAssetId, sourceFramePath);
    } else {
      const sourcePath = await this.store.materialize(project.source_storage_key, join(workDir, 'source'));
      await this.commandRunner(this.ffmpegBinary, buildExactFrameExtractionArgs(sourcePath, Number(project.frame_seconds), sourceFramePath));
      sourceFrameAssetId = (await this.storeFile(project.source_id, project.id, 'source-frame.png', sourceFramePath, 'image/png')).id;
    }
    await this.updateProgress(jobId, 30);

    let provider = project.segmentation_provider;
    if (subjectAssetId) {
      await this.materializeAsset(subjectAssetId, subjectPath);
    } else {
      provider = await this.segment(project, sourceFramePath, subjectPath);
      subjectAssetId = (await this.storeFile(project.source_id, project.id, 'subject.png', subjectPath, 'image/png')).id;
    }
    await this.updateProgress(jobId, 55);

    const headlineCard = selectedHeadlineCard(project.social_copy, project.source_headline_card_id);
    const brand = await this.resolveBrandAsset(project.brand_asset_id, workDir);
    const composition = compositionFromManifest(project.manifest_json, headlineCard, brand?.brandAssetId ?? project.brand_asset_id);
    await mkdir(join(workDir, 'variants'), { recursive: true });
    const variants: ThumbnailVariant[] = [];
    let previewAssetId: string | null = null;
    for (const variant of THUMBNAIL_VARIANTS) {
      const variantPath = variant.layoutPreset === composition.layoutPreset
        ? previewPath
        : join(workDir, 'variants', `${variant.layoutPreset}.jpg`);
      await this.renderComposite(sourceFramePath, subjectPath, brand?.path ?? null, { ...composition, layoutPreset: variant.layoutPreset, backgroundPreset: variant.layoutPreset === composition.layoutPreset ? composition.backgroundPreset : defaultBackgroundForLayout(variant.layoutPreset) }, variantPath, 'preview');
      const stored = await this.storeFile(project.source_id, project.id, variant.layoutPreset === composition.layoutPreset ? 'preview.jpg' : `variants/${variant.layoutPreset}.jpg`, variantPath, 'image/jpeg');
      if (variant.layoutPreset === composition.layoutPreset) previewAssetId = stored.id;
      variants.push({ layoutPreset: variant.layoutPreset, label: variant.label, key: `thumbnails/${project.id}/${variant.layoutPreset === composition.layoutPreset ? 'preview.jpg' : `variants/${variant.layoutPreset}.jpg`}`, assetId: stored.id });
    }
    if (!previewAssetId) {
      const fallback = variants.find((variant) => variant.layoutPreset === 'clean_cut') ?? variants[0];
      previewAssetId = fallback?.assetId ?? null;
    }
    const manifest = createThumbnailManifest({
      project,
      provider,
      headlineCard,
      brandAssetId: brand?.brandAssetId ?? project.brand_asset_id,
      brandAssetDbId: brand?.assetId ?? null,
      sourceFrameAssetId,
      subjectAssetId,
      previewAssetId,
      exportAssetId: project.export_asset_id,
      composition,
      variants,
      width: this.width,
      height: this.height,
    });
    await this.storeManifest(project, manifest);
    await this.db.query("UPDATE thumbnail_projects SET segmentation_provider=$2,source_frame_asset_id=$3,subject_asset_id=$4,preview_asset_id=$5,manifest_json=$6::jsonb,status='ready',error=NULL,updated_at=now() WHERE id=$1", [project.id, provider, sourceFrameAssetId, subjectAssetId, previewAssetId, JSON.stringify(manifest)]);
    await this.updateProgress(jobId, 90);
  }

  private async processExport(jobId: string, project: ThumbnailProjectRow, workDir: string) {
    if (!project.source_frame_asset_id || !project.subject_asset_id || !project.preview_asset_id) throw new Error('Thumbnail preview must be ready before export');
    const [sourceFramePath, subjectPath] = await Promise.all([
      this.materializeAsset(project.source_frame_asset_id, join(workDir, 'source-frame')),
      this.materializeAsset(project.subject_asset_id, join(workDir, 'subject')),
    ]);
    const headlineCard = selectedHeadlineCard(project.social_copy, project.source_headline_card_id);
    const brand = await this.resolveBrandAsset(project.brand_asset_id, workDir);
    const exportPath = join(workDir, 'export.png');
    const composition = compositionFromManifest(project.manifest_json, headlineCard, brand?.brandAssetId ?? project.brand_asset_id);
    await this.renderComposite(sourceFramePath, subjectPath, brand?.path ?? null, composition, exportPath, 'export');
    const exported = await this.storeFile(project.source_id, project.id, 'export.png', exportPath, 'image/png');
    const existing = project.manifest_json ?? {};
    const createdAt = typeof existing.createdAt === 'string' ? existing.createdAt : undefined;
    const manifest = createThumbnailManifest({
      project,
      provider: project.segmentation_provider,
      headlineCard,
      brandAssetId: brand?.brandAssetId ?? project.brand_asset_id,
      brandAssetDbId: brand?.assetId ?? null,
      sourceFrameAssetId: project.source_frame_asset_id,
      subjectAssetId: project.subject_asset_id,
      previewAssetId: project.preview_asset_id,
      exportAssetId: exported.id,
      createdAt,
      composition,
      variants: manifestVariants(project.manifest_json),
      width: this.width,
      height: this.height,
    });
    await this.storeManifest(project, manifest);
    await this.db.query("UPDATE thumbnail_projects SET export_asset_id=$2,manifest_json=$3::jsonb,status='completed',error=NULL,updated_at=now() WHERE id=$1", [project.id, exported.id, JSON.stringify(manifest)]);
    await this.updateProgress(jobId, 90);
  }

  private async segment(project: ThumbnailProjectRow, sourceFramePath: string, outputPath: string) {
    const input = { sourceFramePath, outputPath, positiveBox: project.positive_box, negativeBoxes: Array.isArray(project.negative_boxes) ? project.negative_boxes : [], protectedBoxes: Array.isArray(project.protected_boxes) ? project.protected_boxes : [] };
    return segmentThumbnail(project.segmentation_provider, input, { sam3: this.sam3, u2netp: this.u2netp });
  }

  private async renderComposite(sourceFramePath: string, subjectPath: string, logoPath: string | null, composition: ThumbnailComposition, outputPath: string, format: 'preview' | 'export') {
    const args = ['-y', '-i', sourceFramePath, '-i', subjectPath];
    if (logoPath) args.push('-i', logoPath);
    const filter = buildThumbnailFilter(this.width, this.height, Boolean(logoPath), composition);
    args.push('-filter_complex', filter, '-map', '[out]', '-frames:v', '1');
    if (format === 'preview') args.push('-q:v', '2');
    else args.push('-c:v', 'png');
    args.push(outputPath);
    await this.commandRunner(this.ffmpegBinary, args);
  }

  private async loadProject(projectId: string) {
    const result = await this.db.query(`
      SELECT project.*, candidate.social_copy, source_asset.storage_key AS source_storage_key
      FROM thumbnail_projects AS project
      JOIN clip_candidates AS candidate ON candidate.id=project.candidate_id
      LEFT JOIN LATERAL (
        SELECT storage_key FROM assets
        WHERE source_id=project.source_id AND role='source'
        ORDER BY created_at DESC LIMIT 1
      ) AS source_asset ON true
      WHERE project.id=$1
    `, [projectId]);
    if (!result.rowCount) throw new Error(`Thumbnail project ${projectId} was not found`);
    if (!result.rows[0].source_storage_key) throw new Error(`Thumbnail project ${projectId} has no source asset`);
    return result.rows[0] as ThumbnailProjectRow;
  }

  private async resolveBrandAsset(requestedId: string | null, workDir: string) {
    const result = requestedId
      ? await this.db.query('SELECT b.id AS brand_asset_id,b.asset_id,a.storage_key FROM brand_assets b JOIN assets a ON a.id=b.asset_id WHERE b.id=$1 AND b.active=true', [requestedId])
      : await this.db.query("SELECT b.id AS brand_asset_id,b.asset_id,a.storage_key FROM brand_assets b JOIN assets a ON a.id=b.asset_id WHERE b.active=true ORDER BY CASE WHEN b.name='General Axios' THEN 0 ELSE 1 END,b.created_at LIMIT 1");
    if (!result.rowCount) {
      if (requestedId) throw new Error(`Brand asset ${requestedId} was not found or is inactive`);
      return null;
    }
    const row = result.rows[0] as { brand_asset_id: string; asset_id: string; storage_key: string };
    return { brandAssetId: row.brand_asset_id, assetId: row.asset_id, path: await this.store.materialize(row.storage_key, join(workDir, 'brand')) };
  }

  private async materializeAsset(assetId: string, workDir: string) {
    const result = await this.db.query('SELECT storage_key FROM assets WHERE id=$1', [assetId]);
    if (!result.rowCount) throw new Error(`Thumbnail asset ${assetId} was not found`);
    return this.store.materialize(result.rows[0].storage_key as string, workDir);
  }

  private async storeFile(sourceId: string, projectId: string, filename: string, path: string, contentType: string) {
    const key = `thumbnails/${projectId}/${filename}`;
    const stored = await this.store.putStream(key, createReadStream(path));
    return this.insertAsset(sourceId, key, contentType, stored.byteSize);
  }

  private async storeManifest(project: ThumbnailProjectRow, manifest: Record<string, unknown>) {
    const key = `thumbnails/${project.id}/thumbnail-manifest.json`;
    const body = Buffer.from(JSON.stringify(manifest, null, 2));
    await this.store.put(key, body);
    await this.insertAsset(project.source_id, key, 'application/json', body.byteLength);
  }

  private async insertAsset(sourceId: string, key: string, contentType: string, byteSize: number) {
    const result = await this.db.query("INSERT INTO assets(source_id,storage_key,role,content_type,byte_size,public_reference,metadata) VALUES($1,$2,'render',$3,$4,$5,$6) ON CONFLICT(storage_key) DO UPDATE SET byte_size=EXCLUDED.byte_size,content_type=EXCLUDED.content_type,metadata=EXCLUDED.metadata RETURNING id,storage_key", [sourceId, key, contentType, byteSize, this.store.getPublicReference(key), { renderer: 'ffmpeg', purpose: 'thumbnail' }]);
    return result.rows[0] as StoredThumbnailAsset;
  }

  private async updateProgress(jobId: string, progress: number) {
    await this.db.query("UPDATE thumbnail_jobs SET progress=$2,lease_expires_at=now() + ($3 * interval '1 second'),updated_at=now() WHERE id=$1 AND status='processing'", [jobId, progress, this.leaseSeconds]);
  }

  private async refreshLease(jobId: string) {
    try {
      await this.db.query("UPDATE thumbnail_jobs SET lease_expires_at=now() + ($2 * interval '1 second'),updated_at=now() WHERE id=$1 AND status='processing'", [jobId, this.leaseSeconds]);
    } catch { /* completion is guarded by the job state */ }
  }
}

function selectedHeadlineCard(socialCopy: Record<string, unknown>, id: string | null): HeadlineCard | null {
  if (!id) {
    const headline = typeof socialCopy.headline === 'string' ? socialCopy.headline.trim() : '';
    return headline ? { id: 'candidate-headline', text: headline, color: null } : null;
  }
  if (!Array.isArray(socialCopy.headlineCards)) return null;
  const card = socialCopy.headlineCards.find((value) => value && typeof value === 'object' && (value as { id?: unknown }).id === id) as Record<string, unknown> | undefined;
  if (!card || typeof card.text !== 'string') throw new Error(`Headline card ${id} was not found on the candidate`);
  return { id, text: card.text, color: typeof card.color === 'string' ? card.color : null };
}

function buildThumbnailFilter(width: number, height: number, hasLogo: boolean, composition: ThumbnailComposition) {
  const layout = composition.layoutPreset;
  const isOriginal = layout === 'original' || composition.backgroundPreset === 'source';
  const backgroundMode = composition.backgroundPreset;
  const filters = [isOriginal
    ? `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}[background]`
    : `${opaqueBackground(width, height, backgroundMode)}[background]`];
  let current = 'background';

  const subjectScale = Math.max(0.5, Math.min(2, composition.subject.scale));
  const subjectWidth = (layout === 'split_focus' ? 0.53 : layout === 'original' ? 0.48 : layout === 'minimal_portrait' ? 0.42 : 0.56) * subjectScale;
  const subjectHeight = (layout === 'split_focus' ? 0.92 : 0.96) * subjectScale;
  filters.push(`[1:v]scale=${Math.round(width * subjectWidth)}:${Math.round(height * subjectHeight)}:force_original_aspect_ratio=decrease[subject]`);
  const subjectX = layout === 'original' ? `(W-w)*${clampUnit(composition.subject.position.x)}` : layout === 'split_focus' ? 'W-w-W*0.04' : layout === 'question' ? 'W-w-W*0.03' : 'W-w-W*0.045';
  const subjectY = layout === 'original' ? `(H-h)*${clampUnit(composition.subject.position.y)}` : 'H-h-H*0.02';
  filters.push(`[${current}][subject]overlay=x=${subjectX}:y=${subjectY}:eof_action=repeat[scene]`);
  current = 'scene';

  if (hasLogo) {
    const logo = logoOverlay(composition.logo.position, width, height);
    filters.push(`[2:v]scale=-1:${Math.round(height * 0.09)}[logo]`);
    filters.push(`[${current}][logo]overlay=${logo.x}:${logo.y}[branded]`);
    current = 'branded';
  }

  const headline = composition.headline.text.trim();
  if (headline) {
    const text = escapeDrawText(wrapHeadline(headline, layout));
    const lightText = backgroundMode === 'white' || backgroundMode === 'gradient_white_blue' || layout === 'split_focus' || layout === 'question';
    const textColor = lightText ? '0x101624' : 'white';
    const boxed = layout === 'original' || layout === 'split_focus' || layout === 'question';
    const boxColor = lightText ? 'white' : '0x0A2342';
    const x = layout === 'original' || layout === 'split_focus' || layout === 'question' ? Math.round(width * 0.05) : Math.round(width * 0.06);
    const y = layout === 'original' ? Math.round(height * 0.68) : layout === 'split_focus' || layout === 'question' ? Math.round(height * 0.16) : Math.round(height * 0.12);
    const boxWidth = layout === 'original' ? Math.round(width * 0.88) : layout === 'split_focus' || layout === 'question' ? Math.round(width * 0.46) : Math.round(width * 0.44);
    const boxHeight = layout === 'original' ? Math.round(height * 0.24) : Math.round(height * 0.28);
    const fontSize = Math.max(28, Math.min(112, Math.round(height * (composition.headline.size / 1000))));
    const alignX = composition.headline.alignment === 'center' ? `(w-text_w)/2` : composition.headline.alignment === 'right' ? `w-text_w-${Math.round(width * 0.05)}` : x + Math.round(width * 0.02);
    const fontFile = process.env.NB_INTERNATIONAL_FONT_FILE ? `fontfile='${escapeFilterPath(process.env.NB_INTERNATIONAL_FONT_FILE)}':` : '';
    const layoutAccent = layout === 'framed_insight' ? `,drawbox=x=${Math.round(width * 0.7)}:y=${Math.round(height * 0.08)}:w=${Math.round(width * 0.25)}:h=${Math.round(height * 0.84)}:color=0x3B6BE3@0.95:t=18` : '';
    const questionMark = layout === 'question' ? `,drawtext=${fontFile}text='?':fontcolor=0x3B6BE3:fontsize=${Math.round(height * 0.7)}:x=${Math.round(width * 0.68)}:y=${Math.round(height * 0.15)}` : '';
    const box = boxed ? `drawbox=x=${x}:y=${y}:w=${boxWidth}:h=${boxHeight}:color=${boxColor}:t=fill,` : '';
    filters.push(`[${current}]${box}drawtext=${fontFile}text='${text}':fontcolor=${textColor}:fontsize=${fontSize}:x=${alignX}:y=${y + Math.round(height * 0.055)}:line_spacing=4${layoutAccent}${questionMark}[out]`);
  } else {
    filters.push(`[${current}]null[out]`);
  }
  return filters.join(';');
}

function opaqueBackground(width: number, height: number, preset: ThumbnailBackgroundPreset) {
  const solid = ({ dark_blue: '0x102143', black: '0x05070A', white: '0xF7F8FA' } as Partial<Record<ThumbnailBackgroundPreset, string>>)[preset];
  if (solid) return `color=c=${solid}:s=${width}x${height}`;
  const gradients: Record<string, { r: string; g: string; b: string }> = {
    gradient_blue: { r: '20+35*X/W', g: '54+75*Y/H', b: '150+95*X/W' },
    gradient_cobalt: { r: '10+30*Y/H', g: '35+75*X/W', b: '105+125*Y/H' },
    gradient_royal: { r: '38+85*Y/H', g: '25+35*X/W', b: '120+105*X/W' },
    gradient_dark: { r: '5+20*X/W', g: '12+25*Y/H', b: '30+45*X/W' },
    gradient_white_blue: { r: '248-18*X/W', g: '250-22*X/W', b: '252-35*Y/H' },
  };
  const gradient = gradients[preset] ?? gradients.gradient_blue;
  return `color=c=black:s=${width}x${height},geq=r='${gradient.r}':g='${gradient.g}':b='${gradient.b}'`;
}

function defaultBackgroundForLayout(layout: ThumbnailLayoutPreset): ThumbnailBackgroundPreset {
  if (layout === 'original') return 'source';
  if (layout === 'split_focus' || layout === 'question') return 'gradient_white_blue';
  if (layout === 'topic_first' || layout === 'data_callout' || layout === 'behind_numbers') return 'gradient_cobalt';
  if (layout === 'event_stage' || layout === 'motion_gradient') return 'gradient_royal';
  if (layout === 'minimal_portrait') return 'gradient_dark';
  return 'gradient_blue';
}

function wrapHeadline(value: string, layout: ThumbnailLayoutPreset) {
  const limit = layout === 'original' ? 34 : layout === 'question' || layout === 'split_focus' ? 22 : 19;
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > limit) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.slice(0, 5).join('\n');
}

function clampUnit(value: number) {
  return Math.max(0, Math.min(1, value));
}

function logoOverlay(position: ThumbnailComposition['logo']['position'], width: number, height: number) {
  const x = position.endsWith('left') ? Math.round(width * 0.04) : position.endsWith('right') ? `W-w-${Math.round(width * 0.04)}` : '(W-w)/2';
  const y = position.startsWith('top') ? Math.round(height * 0.05) : position.startsWith('bottom') ? `H-h-${Math.round(height * 0.05)}` : '(H-h)/2';
  return { x, y };
}

function escapeFilterPath(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
}

function escapeDrawText(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '\\%').replace(/[\r\n]+/g, ' ').slice(0, 180);
}

function sidecarEndpoint(baseUrl: string) {
  const url = new URL(baseUrl);
  if (!url.pathname || url.pathname === '/') url.pathname = '/segment';
  return url.toString();
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
