import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import pg from 'pg';
import { AssetStore } from '@clipper/storage';

export interface PlaybackPreviewOptions {
  ffmpegBinary?: string;
  ffprobeBinary?: string;
  maxDimension?: number;
  preset?: string;
  crf?: number;
  timeoutSeconds?: number;
}

export interface PlaybackPreviewResult {
  status: 'generated' | 'skipped';
  assetId: string;
  storageKey: string;
  byteSize: number;
}

const DEFAULT_MAX_DIMENSION = 1280;
const DEFAULT_PRESET = 'veryfast';
const DEFAULT_CRF = 23;
const DEFAULT_TIMEOUT_SECONDS = 20 * 60;

export function buildPlaybackPreviewArgs(sourcePath: string, outputPath: string, options: { maxDimension?: number; preset?: string; crf?: number; fps?: number } = {}) {
  const maxDimension = positiveInteger(options.maxDimension, DEFAULT_MAX_DIMENSION);
  const preset = options.preset ?? DEFAULT_PRESET;
  const crf = positiveInteger(options.crf, DEFAULT_CRF);
  const keyframeInterval = Math.max(1, Math.round(positiveNumber(options.fps, 30) * 2));
  return [
    '-y', '-nostdin', '-i', sourcePath,
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', `scale=w='min(${maxDimension},iw)':h='min(${maxDimension},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-g', String(keyframeInterval), '-keyint_min', String(keyframeInterval), '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath,
  ];
}

export class PlaybackPreviewGenerator {
  private readonly ffmpegBinary: string;
  private readonly ffprobeBinary: string;
  private readonly maxDimension: number;
  private readonly preset: string;
  private readonly crf: number;
  private readonly timeoutMs: number;

  constructor(private readonly db: pg.Pool, private readonly store: AssetStore, options: PlaybackPreviewOptions = {}) {
    this.ffmpegBinary = options.ffmpegBinary ?? process.env.FFMPEG_BIN ?? 'ffmpeg';
    this.ffprobeBinary = options.ffprobeBinary ?? process.env.FFPROBE_BIN ?? 'ffprobe';
    this.maxDimension = positiveInteger(options.maxDimension ?? Number(process.env.PLAYBACK_PREVIEW_MAX_DIMENSION), DEFAULT_MAX_DIMENSION);
    this.preset = options.preset ?? process.env.PLAYBACK_PREVIEW_PRESET ?? DEFAULT_PRESET;
    this.crf = positiveInteger(options.crf ?? Number(process.env.PLAYBACK_PREVIEW_CRF), DEFAULT_CRF);
    this.timeoutMs = positiveNumber(options.timeoutSeconds ?? Number(process.env.PLAYBACK_PREVIEW_TIMEOUT_SECONDS), DEFAULT_TIMEOUT_SECONDS) * 1000;
  }

  async ensure(sourceId: string, sourceStorageKey: string, parentWorkDir: string): Promise<PlaybackPreviewResult> {
    const existing = await this.db.query("SELECT id,storage_key,byte_size FROM assets WHERE source_id=$1 AND role='preview' ORDER BY created_at DESC LIMIT 1", [sourceId]);
    if (existing.rowCount) {
      const row = existing.rows[0];
      return { status: 'skipped', assetId: row.id as string, storageKey: row.storage_key as string, byteSize: Number(row.byte_size ?? 0) };
    }

    const workDir = join(parentWorkDir, 'playback-preview');
    const outputPath = join(workDir, 'playback.mp4');
    const storageKey = `previews/${sourceId}/playback.mp4`;
    await mkdir(workDir, { recursive: true });
    try {
      const sourcePath = await this.store.materialize(sourceStorageKey, join(workDir, 'source'));
      await runPreviewCommand(this.ffmpegBinary, buildPlaybackPreviewArgs(sourcePath, outputPath, { maxDimension: this.maxDimension, preset: this.preset, crf: this.crf }), this.timeoutMs, 'playback preview ffmpeg');
      await this.validate(outputPath);
      const outputStat = await stat(outputPath);
      const stored = await this.store.putStream(storageKey, createReadStream(outputPath));
      try {
        const asset = await this.db.query("INSERT INTO assets(source_id,storage_key,role,content_type,byte_size,public_reference,metadata) VALUES($1,$2,'preview','video/mp4',$3,$4,$5) ON CONFLICT(storage_key) DO UPDATE SET source_id=EXCLUDED.source_id, role=EXCLUDED.role, content_type=EXCLUDED.content_type, byte_size=EXCLUDED.byte_size, public_reference=EXCLUDED.public_reference, metadata=EXCLUDED.metadata RETURNING id,storage_key,byte_size", [sourceId, storageKey, stored.byteSize || outputStat.size, this.store.getPublicReference(storageKey), { renderer: 'ffmpeg', sourceStorageKey, maxDimension: this.maxDimension, preset: this.preset, crf: this.crf, keyframeIntervalSeconds: 2 }]);
        const row = asset.rows[0];
        return { status: 'generated', assetId: row.id as string, storageKey: row.storage_key as string, byteSize: Number(row.byte_size ?? stored.byteSize ?? outputStat.size) };
      } catch (error) {
        await this.store.delete(storageKey).catch(() => undefined);
        throw error;
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async validate(outputPath: string) {
    const result = await runPreviewCommand(this.ffprobeBinary, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', outputPath], this.timeoutMs, 'playback preview ffprobe', true);
    const streams = JSON.parse(result.stdout).streams as Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    const largestDimension = Math.max(Number(video?.width ?? 0), Number(video?.height ?? 0));
    if (!video || video.codec_name !== 'h264' || largestDimension > this.maxDimension || (audio && audio.codec_name !== 'aac')) {
      throw new Error(`Playback preview validation failed: ${JSON.stringify({ video, audio, maxDimension: this.maxDimension })}`);
    }
  }
}

function runPreviewCommand(command: string, args: string[], timeoutMs: number, label: string, captureOutput = false): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', captureOutput ? 'pipe' : 'ignore', 'pipe'] });
    let stderr = '';
    let stdout = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve({ stdout });
    };
    const timeoutHandler = () => {
      signalProcessGroup(child.pid, 'SIGTERM');
      const killTimer = setTimeout(() => signalProcessGroup(child.pid, 'SIGKILL'), 2_000);
      killTimer.unref?.();
      finish(new Error(`${label} timed out after ${timeoutMs}ms: ${stderr.trim()}`));
    };
    timeout = setTimeout(timeoutHandler, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-12_000); });
    child.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    child.once('close', (code, signal) => code === 0 ? finish() : finish(new Error(`${label} exited with ${code ?? 'null'}${signal ? ` (${signal})` : ''}: ${stderr.trim()}`)));
  });
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      try { process.kill(pid, signal); } catch { /* The process may have exited. */ }
    }
  }
}

function positiveNumber(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : fallback;
}

function positiveInteger(value: number | undefined, fallback: number) {
  return Math.max(1, Math.round(positiveNumber(value, fallback)));
}
