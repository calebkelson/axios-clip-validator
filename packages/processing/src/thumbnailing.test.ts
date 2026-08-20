import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
};

test('exact frame extraction uses output seeking after the source input and writes JPEG', () => {
  assert.deepEqual(buildExactFrameExtractionArgs('/tmp/source.mp4', 12.3456, '/tmp/frame.jpg'), [
    '-y', '-i', '/tmp/source.mp4', '-ss', '12.346', '-map', '0:v:0', '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '2', '/tmp/frame.jpg',
  ]);
});

test('SAM3 sidecar uses the local JSON protocol and copies the returned subject PNG', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'sam3-sidecar-client-'));
  const sourceFramePath = join(workDir, 'source-frame.png');
  const outputPath = join(workDir, 'subject.png');
  const subjectPngPath = join(workDir, 'sidecar-subject.png');
  const maskPath = join(workDir, 'sidecar-mask.png');
  const positiveBox = { x: 0.1, y: 0.2, width: 0.4, height: 0.6 };
  const negativeBoxes = [{ x: 0.65, y: 0.1, width: 0.2, height: 0.3 }];
  await writeFile(sourceFramePath, 'local source frame bytes');
  await writeFile(subjectPngPath, 'subject output bytes');
  await writeFile(maskPath, 'mask output bytes');

  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  try {
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({ subjectPath: subjectPngPath, maskPath }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await new Sam3SidecarClient('http://127.0.0.1:18766').segment({
      sourceFramePath,
      outputPath,
      positiveBox,
      negativeBoxes,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestUrl, 'http://127.0.0.1:18766/segment');
  assert.equal(requestInit?.method, 'POST');
  assert.equal(new Headers(requestInit?.headers).get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    framePath: sourceFramePath,
    positiveBox,
    negativeBoxes,
  });
  assert.equal(await readFile(outputPath, 'utf8'), 'subject output bytes');
  await rm(workDir, { recursive: true, force: true });
});

test('SAM3 sidecar rejects responses whose returned mask file is missing', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'sam3-sidecar-client-'));
  const sourceFramePath = join(workDir, 'source-frame.png');
  const outputPath = join(workDir, 'subject.png');
  const subjectPngPath = join(workDir, 'sidecar-subject.png');
  const missingMaskPath = join(workDir, 'missing-mask.png');
  await writeFile(sourceFramePath, 'local source frame bytes');
  await writeFile(subjectPngPath, 'subject output bytes');

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ subjectPngPath, maskPath: missingMaskPath }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    await assert.rejects(
      new Sam3SidecarClient('http://127.0.0.1:18766').segment({
        sourceFramePath,
        outputPath,
        positiveBox: { x: 0, y: 0, width: 1, height: 1 },
        negativeBoxes: [],
      }),
      /maskPath is invalid/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workDir, { recursive: true, force: true });
  }
});
test('SAM3 is used when selected and available', async () => {
  const sam3 = new FakeSegmentationProvider('sam3');
  const u2netp = new FakeSegmentationProvider('u2netp');
  assert.equal(await segmentThumbnail('sam3', segmentationInput, { sam3, u2netp }), 'sam3');
  assert.equal(sam3.calls.length, 1);
  assert.equal(u2netp.calls.length, 0);
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

test('ThumbnailProcessor persists the transparent subject, every variant, and the selected manifest layout', async () => {
  const projectId = '00000000-0000-4000-8000-000000000020';
  const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const assetIds = new Map([
    [`thumbnails/${projectId}/source-frame.jpg`, '00000000-0000-4000-8000-000000000021'],
    [`thumbnails/${projectId}/subject.png`, '00000000-0000-4000-8000-000000000022'],
    [`thumbnails/${projectId}/preview.jpg`, '00000000-0000-4000-8000-000000000023'],
    [`thumbnails/${projectId}/manifest.json`, '00000000-0000-4000-8000-000000000024'],
    ...['original', 'bold_statement', 'topic_first', 'quote_hook', 'data_callout', 'split_focus', 'clean_cut'].map((preset, index) => [
      `thumbnails/${projectId}/variants/${preset}.jpg`, `00000000-0000-4000-8000-${String(30 + index).padStart(12, '0')}`,
    ] as [string, string]),
  ]);
  const storedKeys: string[] = [];
  let persistedManifest: Record<string, unknown> | null = null;
  let projectStatus = 'queued';
  const projectRow = {
    id: projectId,
    candidate_id: '00000000-0000-4000-8000-000000000026',
    source_id: '00000000-0000-4000-8000-000000000027',
    frame_seconds: 8.25,
    source_headline_card_id: 'headline-1',
    brand_asset_id: null,
    segmentation_provider: 'sam3' as const,
    positive_box: { x: 0.1, y: 0.2, width: 0.4, height: 0.6 },
    negative_boxes: [],
    manifest_json: null as Record<string, unknown> | null,
    source_frame_asset_id: null as string | null,
    subject_asset_id: null as string | null,
    preview_asset_id: null as string | null,
    export_asset_id: null as string | null,
    source_storage_key: 'sources/source/original',
    social_copy: { headlineCards: [{ id: 'headline-1', text: 'A useful thumbnail headline', color: 'navy' }] },
  };
  const fakeDb = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('WITH expired AS')) return { rows: [], rowCount: 0 };
      if (sql.includes('WITH selected_job AS')) return { rows: [{ id: '00000000-0000-4000-8000-000000000025', thumbnail_project_id: projectId, project_status: projectStatus }], rowCount: 1 };
      if (sql.includes('SELECT project.*, candidate.social_copy')) return {
        rows: [projectRow],
        rowCount: 1,
      };
      if (sql.includes('SELECT storage_key FROM assets WHERE id=$1')) return { rows: [{ storage_key: 'thumbnail/materialized' }], rowCount: 1 };
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
    async materialize(_key: string, workDir: string) {
      if (workDir.includes('source-frame') || workDir.includes('/subject')) {
        await mkdir(workDir, { recursive: true });
        const path = join(workDir, workDir.includes('/subject') ? 'materialized.png' : 'materialized.jpg');
        await writeFile(path, workDir.includes('/subject') ? transparentPng : 'fake source frame');
        return path;
      }
      return '/tmp/fake-thumbnail-source.mp4';
    },
    async putStream(key: string, stream: NodeJS.ReadableStream) {
      storedKeys.push(key);
      let byteSize = 0;
      for await (const chunk of stream) byteSize += Buffer.byteLength(chunk);
      return { key, byteSize };
    },
    async put(key: string, body: Uint8Array) { storedKeys.push(key); return body.byteLength ? key : key; },
    getPublicReference(key: string) { return `fake://${key}`; },
  } as unknown as AssetStore;
  let sam3Calls = 0;
  const fakeSam3: ThumbnailSegmentationProvider = {
    name: 'sam3',
    async segment({ outputPath }) { sam3Calls += 1; await writeFile(outputPath, transparentPng); },
  };
  const unusedU2netp = new FakeSegmentationProvider('u2netp');
  const commandCalls: string[][] = [];
  const fakeCommand = async (_command: string, args: string[]) => { commandCalls.push(args); await writeFile(args.at(-1)!, 'fake ffmpeg output'); };
  const processor = new ThumbnailProcessor(fakeDb, fakeStore, 60, { sam3Provider: fakeSam3, u2netpProvider: unusedU2netp, commandRunner: fakeCommand });

  assert.equal(await processor.runOnce(), '00000000-0000-4000-8000-000000000025');
  assert.deepEqual(storedKeys, [
    `thumbnails/${projectId}/source-frame.jpg`,
    `thumbnails/${projectId}/subject.png`,
    `thumbnails/${projectId}/variants/original.jpg`,
    `thumbnails/${projectId}/variants/bold_statement.jpg`,
    `thumbnails/${projectId}/variants/topic_first.jpg`,
    `thumbnails/${projectId}/variants/quote_hook.jpg`,
    `thumbnails/${projectId}/variants/data_callout.jpg`,
    `thumbnails/${projectId}/variants/split_focus.jpg`,
    `thumbnails/${projectId}/variants/clean_cut.jpg`,
    `thumbnails/${projectId}/preview.jpg`,
    `thumbnails/${projectId}/manifest.json`,
  ]);
  assert.equal(unusedU2netp.calls.length, 0);
  const manifest = persistedManifest as any;
  assert.equal(manifest?.schema, 'axios.thumbnail.manifest.v1');
  assert.equal(manifest?.composition?.layoutPreset, 'original');
  assert.deepEqual(manifest?.composition?.subject?.position, { x: 0.5, y: 0.52 });
  assert.deepEqual(Object.keys(manifest?.assets?.variants ?? {}), ['original', 'bold_statement', 'topic_first', 'quote_hook', 'data_callout', 'split_focus', 'clean_cut']);
  assert.ok(manifest?.assets?.variants?.split_focus?.assetId);

  projectStatus = 'queued';
  projectRow.manifest_json = { ...manifest, composition: { ...manifest.composition, layoutPreset: 'split_focus' } };
  projectRow.source_frame_asset_id = assetIds.get(`thumbnails/${projectId}/source-frame.jpg`)!;
  projectRow.subject_asset_id = assetIds.get(`thumbnails/${projectId}/subject.png`)!;
  projectRow.preview_asset_id = assetIds.get(`thumbnails/${projectId}/preview.jpg`)!;
  assert.equal(await processor.runOnce(), '00000000-0000-4000-8000-000000000025');
  assert.equal(sam3Calls, 1, 'manifest-only layout updates must reuse the existing cutout');

  projectStatus = 'export_queued';
  assert.equal(await processor.runOnce(), '00000000-0000-4000-8000-000000000025');
  assert.ok(storedKeys.includes(`thumbnails/${projectId}/export.png`));
  const exportCall = commandCalls.find((args) => args.at(-1)?.endsWith('/export.png'));
  assert.ok(exportCall?.some((arg) => arg.includes('y=50:')));
});
