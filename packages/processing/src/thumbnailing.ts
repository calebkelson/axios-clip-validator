import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import type { AssetStore } from '@clipper/storage';

export type ThumbnailBox = { x: number; y: number; width: number; height: number };
export const THUMBNAIL_LAYOUT_PRESETS = ['original', 'bold_statement', 'topic_first', 'quote_hook', 'data_callout', 'split_focus', 'clean_cut'] as const;
export type ThumbnailLayoutPreset = typeof THUMBNAIL_LAYOUT_PRESETS[number];
export type ThumbnailComposition = {
  layoutPreset: ThumbnailLayoutPreset;
  subject: { position: { x: number; y: number }; scale: number };
  headline: { text: string; sourceCardId: string | null };
  background: { preset: 'black' | 'white' | 'dark_blue' | 'blurred' };
  logo: { enabled: boolean; brandAssetId: string | null; assetId: string | null; position: 'top-left' | 'top-center' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right' };
};

export type ThumbnailSegmentationInput = {
  sourceFramePath: string;
  outputPath: string;
  positiveBox: ThumbnailBox | null;
  negativeBoxes: ThumbnailBox[];
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

/** HTTP client for the optional SAM3 sidecar. The sidecar returns a transparent PNG. */
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
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(sidecarEndpoint(this.baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body,
          signal: controller.signal,
        });
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
      const result = await response.json() as { subjectPngPath?: unknown; subjectPath?: unknown; maskPath?: unknown };
      const subjectPath = typeof result.subjectPngPath === 'string' && result.subjectPngPath
        ? result.subjectPngPath
        : typeof result.subjectPath === 'string' && result.subjectPath
          ? result.subjectPath
          : null;
      if (!subjectPath) {
        throw new Error('SAM3 sidecar response did not contain subjectPngPath or subjectPath');
      }
      if (typeof result.maskPath !== 'string' || !result.maskPath) {
        throw new Error('SAM3 sidecar response did not contain maskPath');
      }
      await validateSidecarFile(subjectPath, 'subjectPngPath');
      await validateSidecarFile(result.maskPath, 'maskPath');
      await copyFile(subjectPath, input.outputPath);
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
  manifest_json: Record<string, unknown> | null;
  source_frame_asset_id: string | null;
  subject_asset_id: string | null;
  preview_asset_id: string | null;
  export_asset_id: string | null;
  source_storage_key: string;
  social_copy: Record<string, unknown>;
};

type StoredThumbnailAsset = { id: string; storage_key: string };
type StoredVariantAssets = Partial<Record<ThumbnailLayoutPreset, StoredThumbnailAsset>>;

type HeadlineCard = { id: string; text: string; color: string | null };

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
  variantAssets?: StoredVariantAssets;
  createdAt?: string;
  width?: number;
  height?: number;
};

export function createThumbnailManifest(input: ThumbnailManifestInput) {
  const projectId = input.project.id;
  const composition = input.composition ?? defaultThumbnailComposition(input.project, input.headlineCard, input.brandAssetId, input.brandAssetDbId);
  const variants = Object.fromEntries(THUMBNAIL_LAYOUT_PRESETS.map((preset) => [preset, {
    key: `thumbnails/${projectId}/variants/${preset}.jpg`,
    assetId: input.variantAssets?.[preset]?.id ?? null,
  }])) as Record<ThumbnailLayoutPreset, { key: string; assetId: string | null }>;
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
    },
    headlineCard: input.headlineCard,
    branding: { brandAssetId: input.brandAssetId, assetId: input.brandAssetDbId },
    composition,
    assets: {
      sourceFrame: { key: `thumbnails/${projectId}/source-frame.jpg`, assetId: input.sourceFrameAssetId },
      subject: { key: `thumbnails/${projectId}/subject.png`, assetId: input.subjectAssetId },
      preview: { key: `thumbnails/${projectId}/preview.jpg`, assetId: input.previewAssetId },
      manifest: { key: `thumbnails/${projectId}/manifest.json` },
      export: { key: `thumbnails/${projectId}/export.png`, assetId: input.exportAssetId },
      variants,
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function buildExactFrameExtractionArgs(sourcePath: string, frameSeconds: number, outputPath: string) {
  return ['-y', '-i', sourcePath, '-ss', frameSeconds.toFixed(3), '-map', '0:v:0', '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '2', outputPath];
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
    if (project.source_frame_asset_id && project.subject_asset_id && project.manifest_json) {
      await this.processLayoutUpdate(jobId, project, workDir);
      return;
    }
    const sourcePath = await this.store.materialize(project.source_storage_key, join(workDir, 'source'));
    const sourceFramePath = join(workDir, 'source-frame.jpg');
    const subjectPath = join(workDir, 'subject.png');
    await this.commandRunner(this.ffmpegBinary, buildExactFrameExtractionArgs(sourcePath, Number(project.frame_seconds), sourceFramePath));
    const sourceFrame = await this.storeFile(project.source_id, project.id, 'source-frame.jpg', sourceFramePath, 'image/jpeg');
    await this.updateProgress(jobId, 30);

    const provider = await this.segment(project, sourceFramePath, subjectPath);
    await validatePngOutput(subjectPath);
    const subject = await this.storeFile(project.source_id, project.id, 'subject.png', subjectPath, 'image/png');
    await this.updateProgress(jobId, 55);

    const headlineCard = selectedHeadlineCard(project.social_copy, project.source_headline_card_id);
    const brand = await this.resolveBrandAsset(project.brand_asset_id, workDir);
    const composition = defaultThumbnailComposition(project, headlineCard, brand?.brandAssetId ?? project.brand_asset_id, brand?.assetId ?? null, project.manifest_json);
    const rendered = await this.renderPreviewArtifacts(project, workDir, sourceFramePath, subjectPath, headlineCard, brand?.path ?? null, composition, sourceFrame, subject, provider);
    await this.storeManifest(project, rendered.manifest);
    await this.db.query("UPDATE thumbnail_projects SET segmentation_provider=$2,source_frame_asset_id=$3,subject_asset_id=$4,preview_asset_id=$5,manifest_json=$6::jsonb,status='ready',error=NULL,updated_at=now() WHERE id=$1", [project.id, provider, sourceFrame.id, subject.id, rendered.preview.id, JSON.stringify(rendered.manifest)]);
    await this.updateProgress(jobId, 90);
  }

  private async processLayoutUpdate(jobId: string, project: ThumbnailProjectRow, workDir: string) {
    if (!project.source_frame_asset_id || !project.subject_asset_id) throw new Error('Thumbnail layout update requires existing source and subject assets');
    const [sourceFramePath, subjectPath] = await Promise.all([
      this.materializeAsset(project.source_frame_asset_id, join(workDir, 'source-frame')),
      this.materializeAsset(project.subject_asset_id, join(workDir, 'subject')),
    ]);
    await validatePngOutput(subjectPath);
    const headlineCard = selectedHeadlineCard(project.social_copy, project.source_headline_card_id);
    const brand = await this.resolveBrandAsset(project.brand_asset_id, workDir);
    const composition = defaultThumbnailComposition(project, headlineCard, brand?.brandAssetId ?? project.brand_asset_id, brand?.assetId ?? null, project.manifest_json);
    const rendered = await this.renderPreviewArtifacts(
      project,
      workDir,
      sourceFramePath,
      subjectPath,
      headlineCard,
      brand?.path ?? null,
      composition,
      { id: project.source_frame_asset_id, storage_key: `thumbnails/${project.id}/source-frame.jpg` },
      { id: project.subject_asset_id, storage_key: `thumbnails/${project.id}/subject.png` },
      project.segmentation_provider,
    );
    await this.storeManifest(project, rendered.manifest);
    await this.db.query("UPDATE thumbnail_projects SET preview_asset_id=$2,export_asset_id=NULL,manifest_json=$3::jsonb,status='ready',error=NULL,updated_at=now() WHERE id=$1", [project.id, rendered.preview.id, JSON.stringify(rendered.manifest)]);
    await this.updateProgress(jobId, 90);
  }

  private async renderPreviewArtifacts(
    project: ThumbnailProjectRow,
    workDir: string,
    sourceFramePath: string,
    subjectPath: string,
    headlineCard: HeadlineCard | null,
    logoPath: string | null,
    composition: ThumbnailComposition,
    sourceFrame: StoredThumbnailAsset,
    subject: StoredThumbnailAsset,
    provider: 'sam3' | 'u2netp',
  ) {
    const variantsDir = join(workDir, 'variants');
    await mkdir(variantsDir, { recursive: true });
    const variantPaths = new Map<ThumbnailLayoutPreset, string>();
    const variantAssets: StoredVariantAssets = {};
    for (const preset of THUMBNAIL_LAYOUT_PRESETS) {
      const variantPath = join(variantsDir, `${preset}.jpg`);
      await this.renderComposite(sourceFramePath, subjectPath, logoPath, compositionForPreset(composition, preset), variantPath, 'preview');
      variantPaths.set(preset, variantPath);
      variantAssets[preset] = await this.storeFile(project.source_id, project.id, `variants/${preset}.jpg`, variantPath, 'image/jpeg');
    }
    const selectedPath = variantPaths.get(composition.layoutPreset) ?? variantPaths.get('original')!;
    const previewPath = join(workDir, 'preview.jpg');
    await copyFile(selectedPath, previewPath);
    const preview = await this.storeFile(project.source_id, project.id, 'preview.jpg', previewPath, 'image/jpeg');
    const manifest = createThumbnailManifest({
      project,
      provider,
      headlineCard,
      brandAssetId: composition.logo.brandAssetId,
      brandAssetDbId: composition.logo.assetId,
      sourceFrameAssetId: sourceFrame.id,
      subjectAssetId: subject.id,
      previewAssetId: preview.id,
      exportAssetId: project.export_asset_id,
      composition,
      variantAssets,
      width: this.width,
      height: this.height,
    });
    return { preview, manifest };
  }

  private async processExport(jobId: string, project: ThumbnailProjectRow, workDir: string) {
    if (!project.source_frame_asset_id || !project.subject_asset_id || !project.preview_asset_id) throw new Error('Thumbnail preview must be ready before export');
    const [sourceFramePath, subjectPath] = await Promise.all([
      this.materializeAsset(project.source_frame_asset_id, join(workDir, 'source-frame')),
      this.materializeAsset(project.subject_asset_id, join(workDir, 'subject')),
    ]);
    const headlineCard = selectedHeadlineCard(project.social_copy, project.source_headline_card_id);
    const brand = await this.resolveBrandAsset(project.brand_asset_id, workDir);
    const composition = defaultThumbnailComposition(project, headlineCard, brand?.brandAssetId ?? project.brand_asset_id, brand?.assetId ?? null, project.manifest_json);
    const exportPath = join(workDir, 'export.png');
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
      composition,
      variantAssets: manifestVariantAssets(existing),
      createdAt,
      width: this.width,
      height: this.height,
    });
    await this.storeManifest(project, manifest);
    await this.db.query("UPDATE thumbnail_projects SET export_asset_id=$2,manifest_json=$3::jsonb,status='completed',error=NULL,updated_at=now() WHERE id=$1", [project.id, exported.id, JSON.stringify(manifest)]);
    await this.updateProgress(jobId, 90);
  }

  private async segment(project: ThumbnailProjectRow, sourceFramePath: string, outputPath: string) {
    const input = { sourceFramePath, outputPath, positiveBox: project.positive_box, negativeBoxes: Array.isArray(project.negative_boxes) ? project.negative_boxes : [] };
    return segmentThumbnail(project.segmentation_provider, input, { sam3: this.sam3, u2netp: this.u2netp });
  }

  private async renderComposite(sourceFramePath: string, subjectPath: string, logoPath: string | null, composition: ThumbnailComposition, outputPath: string, format: 'preview' | 'export') {
    const args = ['-y', '-i', sourceFramePath, '-i', subjectPath];
    const includeLogo = Boolean(logoPath && composition.logo.enabled);
    if (includeLogo) args.push('-i', logoPath!);
    const filter = buildThumbnailFilter(this.width, this.height, includeLogo, composition);
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
    const key = `thumbnails/${project.id}/manifest.json`;
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
  if (!id || !Array.isArray(socialCopy.headlineCards)) return null;
  const card = socialCopy.headlineCards.find((value) => value && typeof value === 'object' && (value as { id?: unknown }).id === id) as Record<string, unknown> | undefined;
  if (!card || typeof card.text !== 'string') throw new Error(`Headline card ${id} was not found on the candidate`);
  return { id, text: card.text, color: typeof card.color === 'string' ? card.color : null };
}

const LAYOUT_DEFAULTS: Record<ThumbnailLayoutPreset, { position: { x: number; y: number }; scale: number; background: ThumbnailComposition['background']['preset'] }> = {
  original: { position: { x: 0.5, y: 0.52 }, scale: 1, background: 'blurred' },
  bold_statement: { position: { x: 0.56, y: 0.5 }, scale: 1.06, background: 'dark_blue' },
  topic_first: { position: { x: 0.62, y: 0.52 }, scale: 0.92, background: 'dark_blue' },
  quote_hook: { position: { x: 0.52, y: 0.52 }, scale: 1, background: 'black' },
  data_callout: { position: { x: 0.68, y: 0.52 }, scale: 0.9, background: 'dark_blue' },
  split_focus: { position: { x: 0.72, y: 0.52 }, scale: 0.86, background: 'white' },
  clean_cut: { position: { x: 0.5, y: 0.5 }, scale: 1.02, background: 'blurred' },
};

function defaultThumbnailComposition(
  project: ThumbnailProjectRow,
  headlineCard: HeadlineCard | null,
  brandAssetId: string | null,
  brandAssetDbId: string | null,
  existingManifest: Record<string, unknown> | null = null,
): ThumbnailComposition {
  const existing = existingManifest?.composition && typeof existingManifest.composition === 'object'
    ? existingManifest.composition as Record<string, unknown>
    : {};
  const preset = typeof existing.layoutPreset === 'string' && THUMBNAIL_LAYOUT_PRESETS.includes(existing.layoutPreset as ThumbnailLayoutPreset)
    ? existing.layoutPreset as ThumbnailLayoutPreset
    : 'original';
  const defaults = LAYOUT_DEFAULTS[preset];
  const existingSubject = existing.subject && typeof existing.subject === 'object' ? existing.subject as Record<string, unknown> : {};
  const existingPosition = existingSubject.position && typeof existingSubject.position === 'object' ? existingSubject.position as Record<string, unknown> : {};
  const existingHeadline = existing.headline && typeof existing.headline === 'object' ? existing.headline as Record<string, unknown> : {};
  const existingBackground = existing.background && typeof existing.background === 'object' ? existing.background as Record<string, unknown> : {};
  const existingLogo = existing.logo && typeof existing.logo === 'object' ? existing.logo as Record<string, unknown> : {};
  const socialHeadline = typeof project.social_copy.headline === 'string' ? project.social_copy.headline : '';
  const backgroundPreset = typeof existingBackground.preset === 'string' && ['black', 'white', 'dark_blue', 'blurred'].includes(existingBackground.preset)
    ? existingBackground.preset as ThumbnailComposition['background']['preset']
    : defaults.background;
  const logoPosition = typeof existingLogo.position === 'string' && ['top-left', 'top-center', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right'].includes(existingLogo.position)
    ? existingLogo.position as ThumbnailComposition['logo']['position']
    : 'top-left';
  return {
    layoutPreset: preset,
    subject: {
      position: {
        x: typeof existingPosition.x === 'number' ? existingPosition.x : defaults.position.x,
        y: typeof existingPosition.y === 'number' ? existingPosition.y : defaults.position.y,
      },
      scale: typeof existingSubject.scale === 'number' && existingSubject.scale > 0 ? existingSubject.scale : defaults.scale,
    },
    headline: {
      text: headlineCard?.text ?? (typeof existingHeadline.text === 'string' ? existingHeadline.text : socialHeadline),
      sourceCardId: headlineCard?.id ?? (typeof existingHeadline.sourceCardId === 'string' ? existingHeadline.sourceCardId : project.source_headline_card_id),
    },
    background: { preset: backgroundPreset },
    logo: {
      enabled: typeof existingLogo.enabled === 'boolean' ? existingLogo.enabled : Boolean(brandAssetDbId),
      brandAssetId: brandAssetId ?? (typeof existingLogo.brandAssetId === 'string' ? existingLogo.brandAssetId : null),
      assetId: brandAssetDbId ?? (typeof existingLogo.assetId === 'string' ? existingLogo.assetId : null),
      position: logoPosition,
    },
  };
}

function compositionForPreset(composition: ThumbnailComposition, preset: ThumbnailLayoutPreset): ThumbnailComposition {
  if (preset === composition.layoutPreset) return composition;
  const defaults = LAYOUT_DEFAULTS[preset];
  return {
    ...composition,
    layoutPreset: preset,
    subject: { position: defaults.position, scale: defaults.scale },
    background: { preset: defaults.background },
  };
}

function manifestVariantAssets(manifest: Record<string, unknown>): StoredVariantAssets {
  const assets = manifest.assets && typeof manifest.assets === 'object' ? manifest.assets as Record<string, unknown> : {};
  const variants = assets.variants && typeof assets.variants === 'object' ? assets.variants as Record<string, unknown> : {};
  const output: StoredVariantAssets = {};
  for (const preset of THUMBNAIL_LAYOUT_PRESETS) {
    const value = variants[preset];
    if (!value || typeof value !== 'object') continue;
    const assetId = (value as { assetId?: unknown }).assetId;
    const key = (value as { key?: unknown }).key;
    if (typeof assetId === 'string' && typeof key === 'string') output[preset] = { id: assetId, storage_key: key };
  }
  return output;
}

function buildThumbnailFilter(width: number, height: number, hasLogo: boolean, composition: ThumbnailComposition) {
  const background = composition.background.preset === 'black'
    ? `color=c=black:s=${width}x${height}[background]`
    : composition.background.preset === 'white'
      ? `color=c=white:s=${width}x${height}[background]`
      : composition.background.preset === 'dark_blue'
        ? `color=c=0A2342:s=${width}x${height}[background]`
        : `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=18,eq=brightness=-0.18[background]`;
  const subjectWidth = Math.round(width * 0.62 * composition.subject.scale);
  const subjectHeight = Math.round(height * 0.94 * composition.subject.scale);
  const subjectX = `(W-w)*${composition.subject.position.x.toFixed(4)}`;
  const subjectY = `(H-h)*${composition.subject.position.y.toFixed(4)}`;
  const filters = [
    background,
    `[1:v]scale=${subjectWidth}:${subjectHeight}:force_original_aspect_ratio=decrease[subject]`,
    `[background][subject]overlay=x=${subjectX}:y=${subjectY}[scene]`,
  ];
  let current = 'scene';
  if (hasLogo) {
    filters.push(`[2:v]scale=-1:${Math.round(height * 0.09)}[logo]`);
    const logoCoordinates = {
      'top-left': `${Math.round(width * 0.04)}:${Math.round(height * 0.05)}`,
      'top-center': `(W-w)/2:${Math.round(height * 0.05)}`,
      'top-right': `W-w-${Math.round(width * 0.04)}:${Math.round(height * 0.05)}`,
      center: `(W-w)/2:(H-h)/2`,
      'bottom-left': `${Math.round(width * 0.04)}:H-h-${Math.round(height * 0.05)}`,
      'bottom-center': `(W-w)/2:H-h-${Math.round(height * 0.05)}`,
      'bottom-right': `W-w-${Math.round(width * 0.04)}:H-h-${Math.round(height * 0.05)}`,
    }[composition.logo.position];
    filters.push(`[${current}][logo]overlay=${logoCoordinates}[branded]`);
    current = 'branded';
  }
  if (composition.headline.text) {
    const text = escapeDrawText(composition.headline.text);
    const lightText = composition.background.preset === 'white' ? 'black' : 'white';
    const boxColor = composition.background.preset === 'white' ? 'white@0.9' : '0x0A2342@0.92';
    const headlineY = composition.layoutPreset === 'split_focus' || composition.layoutPreset === 'data_callout' ? 0.07 : 0.68;
    const headlineHeight = headlineY < 0.2 ? 0.25 : 0.25;
    filters.push(`[${current}]drawbox=x=${Math.round(width * 0.05)}:y=${Math.round(height * headlineY)}:w=${Math.round(width * 0.9)}:h=${Math.round(height * headlineHeight)}:color=${boxColor}:t=fill,drawtext=text='${text}':fontcolor=${lightText}:fontsize=${Math.round(height * 0.075)}:x=(w-text_w)/2:y=${Math.round(height * (headlineY + 0.055))}[out]`);
  } else {
    filters.push(`[${current}]null[out]`);
  }
  return filters.join(';');
}

function escapeDrawText(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '\\%').replace(/[\r\n]+/g, ' ').slice(0, 180);
}

function sidecarEndpoint(baseUrl: string) {
  const url = new URL(baseUrl);
  if (!url.pathname || url.pathname === '/') url.pathname = '/segment';
  return url.toString();
}

async function validateSidecarFile(filePath: string, field: 'subjectPngPath' | 'maskPath') {
  try {
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error('path is not a regular file');
  } catch (error) {
    const reason = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`SAM3 sidecar response ${field} is invalid (${filePath})${reason}`, { cause: error });
  }
}

async function validatePngOutput(filePath: string) {
  try {
    const header = await readFile(filePath, { encoding: null });
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (header.length < signature.length || !signature.every((value, index) => header[index] === value)) throw new Error('file is not a PNG');
  } catch (error) {
    const reason = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Thumbnail subject output is invalid (${filePath})${reason}`, { cause: error });
  }
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
