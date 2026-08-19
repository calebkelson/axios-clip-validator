import assert from 'node:assert/strict';
import pg from 'pg';
import test from 'node:test';
import type { AssetStore, MultipartAssetStore } from '@clipper/storage';
import { buildApp } from './app.js';

test('multipart upload assembles bounded parts without a whole-file request', async () => {
  const previousPartSize = process.env.UPLOAD_PART_BYTES;
  process.env.UPLOAD_PART_BYTES = String(5 * 1024 * 1024);
  const sourceRows = new Map<string, Record<string, unknown>>();
  const storedParts: Array<{ partNumber: number; byteSize: number }> = [];
  let objectSize = 0;
  const fakeDb = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('INSERT INTO media_sources')) {
        const metadata = params[3] as Record<string, unknown>;
        sourceRows.set(String(params[0]), { id: params[0], source_type: 'upload', media_type: params[1], uri: params[2], metadata });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT id,source_type,metadata FROM media_sources')) {
        const row = sourceRows.get(String(params[0]));
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('SELECT id,source_type,media_type,uri,metadata,created_at FROM media_sources')) {
        const row = sourceRows.get(String(params[0]));
        return { rows: row ? [{ ...row, created_at: new Date() }] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO assets')) {
        return { rows: [{ id: '00000000-0000-4000-8000-000000000101', storage_key: params[1], content_type: params[2], byte_size: params[3], public_reference: params[4] }], rowCount: 1 };
      }
      if (sql.includes('UPDATE media_sources SET metadata')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  const fakeStore = {
    getPublicReference: (key: string) => `r2://${key}`,
    async createMultipartUpload() { return { uploadId: 'upload-1' }; },
    async uploadPart(_key: string, _uploadId: string, partNumber: number, stream: NodeJS.ReadableStream, contentLength: number) {
      let received = 0;
      for await (const chunk of stream) received += Buffer.byteLength(chunk);
      assert.equal(received, contentLength);
      storedParts.push({ partNumber, byteSize: received });
      objectSize += received;
      return { etag: `etag-${partNumber}` };
    },
    async completeMultipartUpload(_key: string, _uploadId: string, parts: Array<{ partNumber: number; etag: string }>) {
      assert.deepEqual(parts, [{ partNumber: 1, etag: 'etag-1' }, { partNumber: 2, etag: 'etag-2' }]);
    },
    async abortMultipartUpload() { throw new Error('abort should not be called'); },
    async head() { return { byteSize: objectSize, contentType: 'video/mp4' }; },
  } as unknown as AssetStore & MultipartAssetStore;
  const app = buildApp(fakeDb, fakeStore, 10 * 1024 * 1024);
  await app.ready();
  try {
    const prepared = await app.inject({
      method: 'POST',
      url: '/v1/uploads/multipart',
      payload: { filename: 'large.mp4', contentType: 'video/mp4', byteSize: 6 * 1024 * 1024, mediaType: 'video', sourceTitle: 'Large source' },
    });
    assert.equal(prepared.statusCode, 201);
    const { sourceId } = prepared.json() as { sourceId: string };

    for (const [partNumber, byteSize] of [[1, 5 * 1024 * 1024], [2, 1 * 1024 * 1024]] as const) {
      const part = await app.inject({
        method: 'POST',
        url: `/v1/uploads/multipart/${sourceId}/parts/${partNumber}`,
        headers: { 'content-type': 'application/octet-stream', 'x-upload-part-size': String(byteSize) },
        payload: Buffer.alloc(byteSize),
      });
      assert.equal(part.statusCode, 200);
    }
    const complete = await app.inject({
      method: 'POST',
      url: `/v1/uploads/multipart/${sourceId}/complete`,
      payload: { parts: [{ partNumber: 1, etag: 'etag-1' }, { partNumber: 2, etag: 'etag-2' }] },
    });
    assert.equal(complete.statusCode, 201);
    assert.deepEqual(storedParts, [{ partNumber: 1, byteSize: 5 * 1024 * 1024 }, { partNumber: 2, byteSize: 1 * 1024 * 1024 }]);
  } finally {
    await app.close();
    if (previousPartSize === undefined) delete process.env.UPLOAD_PART_BYTES;
    else process.env.UPLOAD_PART_BYTES = previousPartSize;
  }
});
