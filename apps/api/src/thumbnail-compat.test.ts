import assert from 'node:assert/strict';
import test from 'node:test';
import { ThumbnailManifestSchema } from '@clipper/contracts';
import { normalizeThumbnailManifest } from './app.js';

test('normalizes legacy thumbnail manifests before API response validation', () => {
  const normalized = normalizeThumbnailManifest({
    schema: 'axios.thumbnail.manifest.v1',
    projectId: '11111111-1111-4111-8111-111111111111',
    candidateId: '22222222-2222-4222-8222-222222222222',
    sourceId: '33333333-3333-4333-8333-333333333333',
    frameSeconds: 12.5,
    dimensions: { width: 1280, height: 720 },
    segmentation: { provider: 'sam3', positiveBox: null, negativeBoxes: [] },
    headlineCard: { id: 'card-1', text: 'A legacy headline', color: null },
    branding: { brandAssetId: null, assetId: null },
    composition: {
      layoutPreset: 'clean_cut',
      subject: { position: { x: 0.6, y: 0.5 }, scale: 1 },
      headline: { sourceCardId: 'card-1', text: 'A legacy headline' },
      background: { preset: 'blurred' },
      logo: { enabled: false, brandAssetId: null, assetId: null, position: 'top-left' },
    },
    assets: {
      sourceFrame: { key: 'thumbnails/project/source-frame.jpg', assetId: null },
      subject: { key: 'thumbnails/project/subject.png', assetId: null },
      preview: { key: 'thumbnails/project/preview.jpg', assetId: null },
      manifest: { key: 'thumbnails/project/manifest.json' },
      export: { key: 'thumbnails/project/export.png', assetId: null },
      variants: {
        clean_cut: { key: 'thumbnails/project/variants/clean_cut.jpg', assetId: null },
      },
    },
    createdAt: '2026-08-20T16:00:00.000Z',
  });

  assert.ok(normalized);
  const parsed = ThumbnailManifestSchema.parse(normalized);
  assert.equal(parsed.composition?.headline.resolvedText, 'A legacy headline');
  assert.equal(parsed.composition?.headline.size, 64);
  assert.equal(parsed.composition?.backgroundPreset, 'source');
  assert.deepEqual(parsed.segmentation.protectedBoxes, []);
  assert.equal(parsed.variants[0]?.layoutPreset, 'clean_cut');
});
