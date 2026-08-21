import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverlayHtml } from './chromium-overlay.js';
import { baseVideoFilter, buildAss, buildEditorCaptionEvents, buildSrt, formatSrtTime, logoOverlayPosition, renderProfiles } from './rendering.js';

const segments = [
  { start_seconds: 10, end_seconds: 12.25, text: 'Axios makes the news easier to understand.' },
  { start_seconds: 12.25, end_seconds: 15, text: 'This line should remain timed to the original transcript.' },
];

test('render profiles match the supported Axios social formats', () => {
  assert.deepEqual(renderProfiles.vertical_reel, { width: 1080, height: 1920, marginX: 64, safeTop: 280, safeBottom: 280, logoHeight: 64, captionMarginV: 360 });
  assert.equal(renderProfiles.square.width, 1080);
  assert.equal(renderProfiles.landscape.height, 1080);
});

test('SRT captions are clipped to the rendered window', () => {
  assert.equal(formatSrtTime(1.234), '00:00:01,234');
  const srt = buildSrt(segments, 11, 14);
  assert.match(srt, /00:00:00,000 -->/);
  assert.match(srt, /news easier to understand\./);
  assert.match(srt, /line should remain timed to the/);
});

test('editor caption events preserve word timing, grouping, and saved edits', () => {
  const events = buildEditorCaptionEvents(segments, 11, 14, { '0-3': 'updates' });
  assert.equal(events[0].startSeconds, 0);
  assert.match(events[0].text, /updates/);
  assert.ok(events.every((event) => event.text.length <= 34));
  assert.ok(events.every((event) => event.words.length <= 6));
});

test('ASS captions match the editor scale, position, and active-word treatment', () => {
  const ass = buildAss(segments, 10, 15, renderProfiles.vertical_reel, 'NB International Pro');
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /Style: Default,NB International Pro/);
  assert.match(ass, /,22,&H00FFFFFF,&H00E36B3B/);
  assert.match(ass, /,1,0,2,5,0,0,0,1/);
  assert.match(ass, /\\pos\(540,1613\)/);
  assert.match(ass, /\\1c&H00E36B3B&/);
  assert.match(ass, /\\1c&H00FFFFFF&/);
  assert.ok((ass.match(/^Dialogue:/gm) ?? []).length > 2);
});

test('logo placement uses the seven approved template anchors', () => {
  assert.deepEqual(logoOverlayPosition(renderProfiles.vertical_reel, 'top-left'), { x: '64', y: '280' });
  assert.deepEqual(logoOverlayPosition(renderProfiles.vertical_reel, 'top-center'), { x: '(main_w-overlay_w)/2', y: '280' });
  assert.deepEqual(logoOverlayPosition(renderProfiles.vertical_reel, 'bottom-right'), { x: 'main_w-overlay_w-64', y: 'main_h-overlay_h-280' });
  assert.deepEqual(logoOverlayPosition(renderProfiles.square, 'center'), { x: '(main_w-overlay_w)/2', y: '(main_h-overlay_h)/2' });
});

test('logo placement accepts a freeform percentage position', () => {
  assert.deepEqual(logoOverlayPosition(renderProfiles.vertical_reel, 'top-left', { x: 27.5, y: 63 }), {
    x: '((main_w-overlay_w)*27.5/100)',
    y: '((main_h-overlay_h)*63/100)',
  });
});

test('video reframe is applied to the source crop filter while preserving the default filter', () => {
  const defaultFilter = baseVideoFilter(renderProfiles.vertical_reel, 'cover', 'dark_blue');
  assert.equal(defaultFilter, 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1');

  const reframedFilter = baseVideoFilter(renderProfiles.vertical_reel, 'cover', 'white', { x: 25, y: 75, scale: 1.25 });
  assert.ok(reframedFilter.includes('scale=iw*1.2500:ih*1.2500'));
  assert.ok(reframedFilter.includes('crop=min(iw\\,1080):min(ih\\,1920):max(0\\,0.2500*(iw-1080)):max(0\\,0.7500*(ih-1920))'));
  assert.ok(reframedFilter.endsWith('pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0xFFFFFF,setsar=1'));
});

test('Chromium overlay gives captions an exact safe width and a word-boundary safety wrap', () => {
  const html = buildOverlayHtml({
    ffmpegBinary: 'ffmpeg',
    sourcePath: '/tmp/source.mp4',
    logoPath: null,
    outputPath: '/tmp/output.mp4',
    workDir: '/tmp',
    baseFilter: 'null',
    logoFilter: null,
    width: 1080,
    height: 1920,
    fps: 30,
    startSeconds: 0,
    duration: 3,
    headlineCards: [],
    nameTags: [],
    captionEvents: [{
      startSeconds: 0,
      endSeconds: 3,
      text: 'People who are really smart, often',
      words: [
        { startSeconds: 0, endSeconds: 0.5, text: 'People' },
        { startSeconds: 0.5, endSeconds: 1, text: 'who' },
        { startSeconds: 1, endSeconds: 1.5, text: 'are' },
        { startSeconds: 1.5, endSeconds: 2, text: 'really' },
        { startSeconds: 2, endSeconds: 2.5, text: 'smart,' },
        { startSeconds: 2.5, endSeconds: 3, text: 'often' },
      ],
    }],
    captionPosition: { x: 50, y: 84 },
    captionStyle: { fontSizePx: 72, maxWidthPercent: 84, gapEm: 0.32 },
    fontPath: null,
  });

  assert.match(html, /\.caption-line \{[^}]*flex-wrap: wrap;[^}]*width: 100%;[^}]*max-width: 100%/);
  assert.match(html, /captions\.style\.width = clamp\(style\.maxWidthPercent, 84, 1, 100\) \+ '%'/);
  assert.match(html, /captions\.style\.maxWidth = 'none'/);
  assert.match(html, /\.headline-card, \.name-tag \{[^}]*overflow: hidden;/);
});
