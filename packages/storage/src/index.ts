import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface AssetStore {
  put(key: string, body: Uint8Array): Promise<string>;
  putStream(key: string, stream: NodeJS.ReadableStream): Promise<{ key: string; byteSize: number }>;
  get(key: string): Promise<Uint8Array>;
  getPath(key: string): string;
  delete(key: string): Promise<void>;
  getPublicReference(key: string): string;
}

export class LocalAssetStore implements AssetStore {
  constructor(private readonly root: string) {}

  private path(key: string) {
    const path = resolve(this.root, key);
    if (!path.startsWith(resolve(this.root) + '/')) throw new Error('Invalid asset key');
    return path;
  }

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
    let byteSize = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteSize += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(stream, counter, createWriteStream(path));
    return { key, byteSize };
  }

  async get(key: string) {
    return readFile(this.path(key));
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }

  getPublicReference(key: string) {
    return `local://${key}`;
  }
}
