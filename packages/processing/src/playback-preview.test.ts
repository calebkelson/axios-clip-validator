import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackPreviewGenerator, buildPlaybackPreviewArgs } from './playback-preview.js';

test('playback preview uses bounded H.264/AAC settings and two-second keyframes', () => {
  const args = buildPlaybackPreviewArgs('/tmp/source.mp4', '/tmp/playback.mp4', { maxDimension: 1280, preset: 'veryfast', crf: 23, fps: 30 });
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('yuv420p'));
  assert.ok(args.includes('aac'));
  assert.ok(args.includes('128k'));
  assert.ok(args.includes('+faststart'));
  assert.ok(args.includes('-g') && args[args.indexOf('-g') + 1] === '60');
  assert.ok(args.some((value) => value.includes('min(1280,iw)')));
  assert.equal(args.at(-1), '/tmp/playback.mp4');
});

test('playback preview is idempotent when a preview asset already exists', async () => {
  const db = {
    query: async () => ({
      rowCount: 1,
      rows: [{ id: 'preview-1', storage_key: 'previews/source-1/playback.mp4', byte_size: '42' }],
    }),
  } as never;
  const store = {
    materialize: async () => { throw new Error('materialize should not run for an existing preview'); },
  } as never;
  const generator = new PlaybackPreviewGenerator(db, store);
  const result = await generator.ensure('source-1', 'sources/source-1/original', '/private/tmp/clipper-preview-test');
  assert.deepEqual(result, {
    status: 'skipped',
    assetId: 'preview-1',
    storageKey: 'previews/source-1/playback.mp4',
    byteSize: 42,
  });
});
