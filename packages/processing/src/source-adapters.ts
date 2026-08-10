import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export type PlatformSource = {
  uri: string;
  provider: string;
  mediaType: 'video' | 'audio';
};

export type DownloadedSource = {
  path: string;
  contentType: string | null;
  byteSize: number;
};

export interface PlatformSourceAdapter {
  readonly name: string;
  supports(provider: string): boolean;
  download(source: PlatformSource, workDir: string, maxBytes: number): Promise<DownloadedSource>;
}

const defaultProviders = ['facebook', 'instagram', 'linkedin', 'tiktok', 'twitter', 'vimeo', 'x', 'youtube'];

export class YtDlpSourceAdapter implements PlatformSourceAdapter {
  readonly name = 'yt-dlp';
  private readonly providers: Set<string>;

  constructor(
    private readonly binary = 'yt-dlp',
    providers = defaultProviders,
  ) {
    this.providers = new Set(providers.map((provider) => provider.trim().toLowerCase()).filter(Boolean));
  }

  supports(provider: string) {
    return this.providers.has(provider.trim().toLowerCase());
  }

  async download(source: PlatformSource, workDir: string, maxBytes: number) {
    if (!this.supports(source.provider)) throw new Error(`Platform provider "${source.provider}" is not enabled for yt-dlp`);
    const outputTemplate = join(workDir, 'source.%(ext)s');
    await execFile(this.binary, [
      '--js-runtimes', 'node',
      '--no-playlist',
      '--restrict-filenames',
      '--max-filesize', String(maxBytes),
      '--merge-output-format', 'mp4',
      '--output', outputTemplate,
      source.uri,
    ], { maxBuffer: 4 * 1024 * 1024 });

    const files = (await readdir(workDir)).filter((file) => !file.endsWith('.part') && !file.endsWith('.ytdl'));
    if (files.length !== 1) throw new Error(`Platform adapter produced ${files.length} media files; expected one`);
    const path = join(workDir, files[0]);
    const byteSize = (await stat(path)).size;
    if (byteSize > maxBytes) throw new Error(`Source exceeds MAX_SOURCE_BYTES (${maxBytes})`);
    return { path, contentType: contentTypeFor(files[0], source.mediaType), byteSize };
  }
}

export function createPlatformSourceAdapter(env: NodeJS.ProcessEnv = process.env): PlatformSourceAdapter | null {
  if ((env.SOURCE_PLATFORM_ADAPTER ?? 'none').toLowerCase() !== 'yt-dlp') return null;
  const providers = (env.SOURCE_PLATFORM_PROVIDERS ?? defaultProviders.join(','))
    .split(',')
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);
  return new YtDlpSourceAdapter(env.YTDLP_BIN ?? 'yt-dlp', providers);
}

function contentTypeFor(filename: string, mediaType: PlatformSource['mediaType']) {
  const extension = filename.toLowerCase().split('.').pop();
  if (extension === 'mp4' || extension === 'm4v') return 'video/mp4';
  if (extension === 'webm') return 'video/webm';
  if (extension === 'mov') return 'video/quicktime';
  if (extension === 'mp3') return 'audio/mpeg';
  return mediaType === 'audio' ? 'audio/octet-stream' : 'video/octet-stream';
}
