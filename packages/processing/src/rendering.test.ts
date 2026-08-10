import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAss, buildSrt, formatSrtTime, logoOverlayPosition, renderProfiles } from './rendering.js';

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
  assert.match(srt, /00:00:00,000 --> 00:00:01,250/);
  assert.match(srt, /00:00:01,250 --> 00:00:03,000/);
  assert.match(srt, /Axios makes the news easier to\nunderstand\./);
});

test('ASS captions carry the profile-safe margins and selected font', () => {
  const ass = buildAss(segments, 10, 15, renderProfiles.vertical_reel, 'NB International Pro');
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /Style: Default,NB International Pro/);
  assert.match(ass, /,64,64,360,1/);
});

test('logo placement uses the seven approved template anchors', () => {
  assert.deepEqual(logoOverlayPosition(renderProfiles.vertical_reel, 'top-left'), { x: '64', y: '280' });
  assert.deepEqual(logoOverlayPosition(renderProfiles.vertical_reel, 'top-center'), { x: '(main_w-overlay_w)/2', y: '280' });
  assert.deepEqual(logoOverlayPosition(renderProfiles.vertical_reel, 'bottom-right'), { x: 'main_w-overlay_w-64', y: 'main_h-overlay_h-280' });
  assert.deepEqual(logoOverlayPosition(renderProfiles.square, 'center'), { x: '(main_w-overlay_w)/2', y: '(main_h-overlay_h)/2' });
});
