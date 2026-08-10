import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createAssetStore, LocalAssetStore } from './index.js';

test('local asset store streams bytes and blocks path traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clipper-storage-'));
  const store = new LocalAssetStore(root);
  const result = await store.putStream('uploads/example.bin', Readable.from([Buffer.from('hello'), Buffer.from(' world')]));
  assert.equal(result.byteSize, 11);
  assert.deepEqual(await store.get('uploads/example.bin'), Buffer.from('hello world'));
  assert.throws(() => store.getPath('../outside.bin'), /Invalid asset key/);
});

test('local asset store serves ranges and materializes a verified path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clipper-storage-'));
  const workDir = await mkdtemp(join(tmpdir(), 'clipper-work-'));
  const store = new LocalAssetStore(root);
  await store.put('renders/example.bin', Buffer.from('0123456789'));
  const ranged = await store.getStream('renders/example.bin', { start: 2, end: 5 });
  const chunks: Buffer[] = [];
  for await (const chunk of ranged.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), '2345');
  assert.equal(ranged.contentLength, 4);
  assert.equal(ranged.totalLength, 10);
  assert.equal(await store.materialize('renders/example.bin', workDir), join(root, 'renders/example.bin'));
});

test('asset store factory stays local unless R2 mode is explicit', () => {
  assert.ok(createAssetStore({ ASSET_DATA_DIR: '/tmp/clipper-local' }).constructor.name === 'LocalAssetStore');
  assert.throws(() => createAssetStore({ ASSET_STORE: 'r2' }), /R2_ENDPOINT is required/);
});
