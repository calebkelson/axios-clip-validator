import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export interface AssetRange {
  start?: number;
  end?: number;
}

export interface AssetStream {
  stream: NodeJS.ReadableStream;
  contentLength: number;
  totalLength: number;
}

export interface AssetStore {
  put(key: string, body: Uint8Array): Promise<string>;
  putStream(key: string, stream: NodeJS.ReadableStream): Promise<{ key: string; byteSize: number }>;
  get(key: string): Promise<Uint8Array>;
  getStream(key: string, range?: AssetRange): Promise<AssetStream>;
  materialize(key: string, workDir: string): Promise<string>;
  delete(key: string): Promise<void>;
  getPublicReference(key: string): string;
}

export class LocalAssetStore implements AssetStore {
  constructor(private readonly root: string) {}

  private path(key: string) {
    const path = resolve(this.root, assertAssetKey(key));
    if (!path.startsWith(resolve(this.root) + '/')) throw new Error('Invalid asset key');
    return path;
  }

  /** Kept for local tooling; processing code should use materialize(). */
  getPath(key: string) {
    return this.path(key);
  }

  async put(key: string, body: Uint8Array) {
    const path = this.path(key);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
    return key;
  }

  async putStream(key: string, stream: NodeJS.ReadableStream) {
    const path = this.path(key);
    await mkdir(join(path, '..'), { recursive: true });
    const counter = byteCounter();
    await pipeline(stream, counter.transform, createWriteStream(path));
    return { key, byteSize: counter.byteSize() };
  }

  async get(key: string) {
    return readFile(this.path(key));
  }

  async getStream(key: string, range?: AssetRange): Promise<AssetStream> {
    const path = this.path(key);
    const fileSize = (await stat(path)).size;
    const start = range?.start ?? 0;
    const end = range?.end ?? fileSize - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= fileSize) {
      throw new Error('Invalid asset range');
    }
    return {
      stream: createReadStream(path, range ? { start, end } : undefined),
      contentLength: range ? end - start + 1 : fileSize,
      totalLength: fileSize,
    };
  }

  async materialize(key: string, workDir?: string) {
    void workDir;
    const path = this.path(key);
    await stat(path);
    return path;
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }

  getPublicReference(key: string) {
    return `local://${assertAssetKey(key)}`;
  }
}

export interface R2AssetStoreOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  cacheDir?: string;
}

/** S3-compatible Cloudflare R2 storage for shared media and generated assets. */
export class R2AssetStore implements AssetStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly cacheDir: string;

  constructor(options: R2AssetStoreOptions) {
    this.bucket = options.bucket;
    this.cacheDir = options.cacheDir ?? process.env.TMPDIR ?? '/tmp/clipper-assets';
    this.client = new S3Client({
      region: options.region ?? 'auto',
      endpoint: options.endpoint,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
  }

  async put(key: string, body: Uint8Array) {
    const safeKey = assertAssetKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: safeKey, Body: body, ContentLength: body.byteLength }));
    return safeKey;
  }

  async putStream(key: string, stream: NodeJS.ReadableStream) {
    const safeKey = assertAssetKey(key);
    const counter = byteCounter();
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: safeKey, Body: counter.transform },
    });
    await Promise.all([pipeline(stream, counter.transform), upload.done()]);
    return { key: safeKey, byteSize: counter.byteSize() };
  }

  async get(key: string) {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: assertAssetKey(key) }));
    if (!response.Body) throw new Error('R2 returned an empty asset body');
    return response.Body.transformToByteArray();
  }

  async getStream(key: string, range?: AssetRange): Promise<AssetStream> {
    const safeKey = assertAssetKey(key);
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: safeKey }));
    const totalLength = Number(head.ContentLength ?? 0);
    if (!Number.isSafeInteger(totalLength) || totalLength < 0) throw new Error('R2 asset has no usable size');
    const rangeHeader = range ? `bytes=${range.start ?? 0}-${range.end ?? ''}` : undefined;
    if (range && (range.start ?? 0) < 0) throw new Error('Invalid asset range');
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: safeKey, ...(rangeHeader ? { Range: rangeHeader } : {}) }));
    if (!response.Body) throw new Error('R2 returned an empty asset body');
    const contentLength = Number(response.ContentLength ?? (range ? (range.end ?? totalLength - 1) - (range.start ?? 0) + 1 : totalLength));
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) throw new Error('R2 asset response has no usable size');
    return { stream: toNodeReadable(response.Body), contentLength, totalLength };
  }

  async materialize(key: string, workDir: string) {
    const safeKey = assertAssetKey(key);
    await mkdir(workDir, { recursive: true });
    const digest = createHash('sha256').update(safeKey).digest('hex');
    const path = join(workDir, `${digest}${extname(safeKey) || '.asset'}`);
    try {
      const asset = await this.getStream(safeKey);
      await pipeline(asset.stream, createWriteStream(path));
      return path;
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: assertAssetKey(key) }));
  }

  getPublicReference(key: string) {
    return `r2://${this.bucket}/${assertAssetKey(key)}`;
  }
}

export function createAssetStore(env: NodeJS.ProcessEnv = process.env): AssetStore {
  if (env.ASSET_STORE !== 'r2') return new LocalAssetStore(env.ASSET_DATA_DIR ?? '/data');
  const required = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;
  for (const name of required) if (!env[name]) throw new Error(`${name} is required when ASSET_STORE=r2`);
  return new R2AssetStore({
    endpoint: env.R2_ENDPOINT!,
    bucket: env.R2_BUCKET!,
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    region: env.R2_REGION ?? 'auto',
    cacheDir: env.ASSET_CACHE_DIR ?? env.TMPDIR ?? '/tmp/clipper-assets',
  });
}

function assertAssetKey(key: string) {
  if (!key || key.startsWith('/') || key.split('/').includes('..') || key.includes('\\')) throw new Error('Invalid asset key');
  return key;
}

function toNodeReadable(body: unknown): NodeJS.ReadableStream {
  if (body && typeof (body as { pipe?: unknown }).pipe === 'function') return body as NodeJS.ReadableStream;
  if (body && typeof (body as { transformToWebStream?: unknown }).transformToWebStream === 'function') {
    const webStream = (body as { transformToWebStream: () => ReadableStream }).transformToWebStream();
    return Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
  }
  throw new Error('R2 returned an unsupported stream body');
}

function byteCounter() {
  let bytes = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  return { transform, byteSize: () => bytes };
}
