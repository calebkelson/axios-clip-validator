import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { LocalAssetStore } from './index.js';

test('local asset store streams bytes and blocks path traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clipper-storage-'));
  const store = new LocalAssetStore(root);
  const result = await store.putStream('uploads/example.bin', Readable.from([Buffer.from('hello'), Buffer.from(' world')]));
  assert.equal(result.byteSize, 11);
  assert.deepEqual(await store.get('uploads/example.bin'), Buffer.from('hello world'));
  assert.throws(() => store.getPath('../outside.bin'), /Invalid asset key/);
});
