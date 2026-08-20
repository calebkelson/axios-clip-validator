import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import test from 'node:test';
import type pg from 'pg';
import type { AssetStore } from '@clipper/storage';
import {
  Sam3UnavailableError,
  Sam3SidecarClient,
  ThumbnailProcessor,
  buildExactFrameExtractionArgs,
  segmentThumbnail,
  type ThumbnailSegmentationInput,
  type ThumbnailSegmentationProvider,
} from './thumbnailing.js';

class FakeSegmentationProvider implements ThumbnailSegmentationProvider {
  calls: ThumbnailSegmentationInput[] = [];

  constructor(
    readonly name: 'sam3' | 'u2netp',
    private readonly failure?: Error,
  ) {}

  async segment(input: ThumbnailSegmentationInput) {
    this.calls.push(input);
    if (this.failure) throw this.failure;
  }
}

const segmentationInput: ThumbnailSegmentationInput = {
  sourceFramePath: '/tmp/source-frame.png',
  outputPath: '/tmp/subject.png',
  positiveBox: { x: 10, y: 20, width: 300, height: 400 },
  negativeBoxes: [],
  protectedBoxes: [],
};

test('exact frame extraction uses output seeking after the source input', () => {
  assert.deepEqual(buildExactFrameExtractionArgs('/tmp/source.mp4', 12.3456, '/tmp/frame.png'), [
    '-y', '-i', '/tmp/source.mp4', '-ss', '12.346', '-map', '0:v:0', '-frames:v', '1', '-c:v', 'png', '/tmp/frame.png',
  ]);
});
test('SAM3 is used when selected and available', async () => {
  const sam3 = new FakeSegmentationProvider('sam3');
  const u2netp = new FakeSegmentationProvider('u2netp');
  assert.equal(await segmentThumbnail('sam3', segmentationInput, { sam3, u2netp }), 'sam3');
  assert.equal(sam3.calls.length, 1);
  assert.equal(u2netp.calls.length, 0);
});

test('SAM3 sidecar receives a JSON frame path and materializes its returned subject path', async () => {
  const outputPath = `/tmp/thumbnail-sam3-output-${process.pid}.png`;
  const subjectPath = `/tmp/thumbnail-sam3-subject-${process.pid}.png`;
  await writeFile(subjectPath, 'transparent subject');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_input, init) => {
      assert.equal((init?.headers as Record<string, string>)['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        framePath: '/tmp/source-frame.png',
        positiveBox: segmentationInput.positiveBox,
        negativeBoxes: [],
        protectedBoxes: [],
      });
      return new Response(JSON.stringify({ subjectPath }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await new Sam3SidecarClient('http://127.0.0.1:18766').segment({ ...segmentationInput, outputPath });
    assert.equal(await readFile(outputPath, 'utf8'), 'transparent subject');
  } finally {
    globalThis.fetch = originalFetch;
    await unlink(outputPath).catch(() => undefined);
    await unlink(subjectPath).catch(() => undefined);
  }
});

test('u2netp is a weights-free test fallback only when SAM3 is unavailable', async () => {
  const sam3 = new FakeSegmentationProvider('sam3', new Sam3UnavailableError('sidecar offline'));
  const u2netp = new FakeSegmentationProvider('u2netp');
  assert.equal(await segmentThumbnail('sam3', segmentationInput, { sam3, u2netp }), 'u2netp');
  assert.equal(u2netp.calls.length, 1);

  const invalidSam3 = new FakeSegmentationProvider('sam3', new Error('invalid prompt'));
  const unusedFallback = new FakeSegmentationProvider('u2netp');
  await assert.rejects(segmentThumbnail('sam3', segmentationInput, { sam3: invalidSam3, u2netp: unusedFallback }), /invalid prompt/);
  assert.equal(unusedFallback.calls.length, 0);
});

test('ThumbnailProcessor persists preview artifacts with an injected fake SAM3 provider', async () => {
  const projectId = '00000000-0000-4000-8000-000000000020';
  const assetIds = new Map([
    [`thumbnails/${projectId}/source-frame.png`, '00000000-0000-4000-8000-000000000021'],
    [`thumbnails/${projectId}/subject.png`, '00000000-0000-4000-8000-000000000022'],
    [`thumbnails/${projectId}/preview.jpg`, '00000000-0000-4000-8000-000000000023'],
    [`thumbnails/${projectId}/thumbnail-manifest.json`, '00000000-0000-4000-8000-000000000024'],
  ]);
  const storedKeys: string[] = [];
  let persistedManifest: Record<string, unknown> | null = null;
  const fakeDb = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('WITH expired AS')) return { rows: [], rowCount: 0 };
      if (sql.includes('WITH selected_job AS')) return { rows: [{ id: '00000000-0000-4000-8000-000000000025', thumbnail_project_id: projectId, project_status: 'queued' }], rowCount: 1 };
      if (sql.includes('SELECT project.*, candidate.social_copy')) return {
        rows: [{
          id: projectId,
          candidate_id: '00000000-0000-4000-8000-000000000026',
          source_id: '00000000-0000-4000-8000-000000000027',
          frame_seconds: 8.25,
          source_headline_card_id: 'headline-1',
          brand_asset_id: null,
          segmentation_provider: 'sam3',
          positive_box: { x: 10, y: 20, width: 300, height: 400 },
          negative_boxes: [],
          protected_boxes: [{ x: 0.48, y: 0.48, width: 0.12, height: 0.25 }],
          manifest_json: null,
          source_frame_asset_id: null,
          subject_asset_id: null,
          preview_asset_id: null,
          export_asset_id: null,
          source_storage_key: 'sources/source/original',
          social_copy: { headlineCards: [{ id: 'headline-1', text: 'A useful thumbnail headline', color: 'navy' }] },
        }],
        rowCount: 1,
      };
      if (sql.includes('INSERT INTO assets')) {
        const key = String(params[1]);
        return { rows: [{ id: assetIds.get(key), storage_key: key }], rowCount: 1 };
      }
      if (sql.includes("WHERE b.active=true ORDER BY")) return { rows: [], rowCount: 0 };
      if (sql.includes("UPDATE thumbnail_projects SET segmentation_provider")) {
        persistedManifest = JSON.parse(String(params[5])) as Record<string, unknown>;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as pg.Pool;
  const fakeStore = {
    async materialize() { return '/tmp/fake-thumbnail-source.mp4'; },
    async putStream(key: string, stream: NodeJS.ReadableStream) {
      storedKeys.push(key);
      let byteSize = 0;
      for await (const chunk of stream) byteSize += Buffer.byteLength(chunk);
      return { key, byteSize };
    },
    async put(key: string, body: Uint8Array) { storedKeys.push(key); return body.byteLength ? key : key; },
    getPublicReference(key: string) { return `fake://${key}`; },
  } as unknown as AssetStore;
  const fakeSam3: ThumbnailSegmentationProvider = {
    name: 'sam3',
    async segment({ outputPath }) { await writeFile(outputPath, 'fake transparent subject'); },
  };
  const unusedU2netp = new FakeSegmentationProvider('u2netp');
  const fakeCommand = async (_command: string, args: string[]) => { await writeFile(args.at(-1)!, 'fake ffmpeg output'); };
  const processor = new ThumbnailProcessor(fakeDb, fakeStore, 60, { sam3Provider: fakeSam3, u2netpProvider: unusedU2netp, commandRunner: fakeCommand });

  assert.equal(await processor.runOnce(), '00000000-0000-4000-8000-000000000025');
  assert.deepEqual(storedKeys, [
    `thumbnails/${projectId}/source-frame.png`,
    `thumbnails/${projectId}/subject.png`,
    `thumbnails/${projectId}/variants/original.jpg`,
    `thumbnails/${projectId}/variants/bold_statement.jpg`,
    `thumbnails/${projectId}/variants/topic_first.jpg`,
    `thumbnails/${projectId}/variants/quote_hook.jpg`,
    `thumbnails/${projectId}/variants/data_callout.jpg`,
    `thumbnails/${projectId}/variants/split_focus.jpg`,
    `thumbnails/${projectId}/preview.jpg`,
    `thumbnails/${projectId}/variants/behind_numbers.jpg`,
    `thumbnails/${projectId}/variants/question.jpg`,
    `thumbnails/${projectId}/variants/event_stage.jpg`,
    `thumbnails/${projectId}/variants/minimal_portrait.jpg`,
    `thumbnails/${projectId}/variants/motion_gradient.jpg`,
    `thumbnails/${projectId}/variants/framed_insight.jpg`,
    `thumbnails/${projectId}/thumbnail-manifest.json`,
  ]);
  assert.equal(unusedU2netp.calls.length, 0);
  assert.equal((persistedManifest as unknown as { schema?: string } | null)?.schema, 'axios.thumbnail.manifest.v1');
});
