import assert from 'node:assert/strict';
import test from 'node:test';
import { mapTranscriptSegments, providerWordPayload } from '../app.js';

test('providerWordPayload keeps real provider timings and stable ids', () => {
  assert.deepEqual(providerWordPayload([
    { id: 'w-1', word: 'First', start: 10.12, end: 10.74 },
    { text: 'point', startSeconds: 10.9, endSeconds: 11.62 },
    { text: 'bad', startSeconds: 11.8, endSeconds: 11.8 },
  ]), [
    { id: 'w-1', text: 'First', startSeconds: 10.12, endSeconds: 10.74 },
    { text: 'point', startSeconds: 10.9, endSeconds: 11.62 },
  ]);
});

test('mapTranscriptSegments preserves stored grouping and aligns provider words by segment', () => {
  const segments = mapTranscriptSegments([
    { start_seconds: '10.00', end_seconds: '11.80', text: 'First point' },
    { start_seconds: '11.80', end_seconds: '13.40', text: 'Second line' },
  ], {
    segments: [
      { startSeconds: 10, endSeconds: 11.8, text: 'First point', words: [
        { id: 'w-1', text: 'First', startSeconds: 10.12, endSeconds: 10.74 },
        { id: 'w-2', text: 'point', startSeconds: 10.90, endSeconds: 11.62 },
      ] },
      { startSeconds: 11.8, endSeconds: 13.4, text: 'Second line', words: [
        { id: 'w-3', text: 'Second', startSeconds: 11.84, endSeconds: 12.30 },
        { id: 'w-4', text: 'line', startSeconds: 12.40, endSeconds: 13.10 },
      ] },
    ],
  });

  assert.deepEqual(segments, [
    {
      startSeconds: 10,
      endSeconds: 11.8,
      text: 'First point',
      words: [
        { id: 'w-1', text: 'First', startSeconds: 10.12, endSeconds: 10.74 },
        { id: 'w-2', text: 'point', startSeconds: 10.9, endSeconds: 11.62 },
      ],
    },
    {
      startSeconds: 11.8,
      endSeconds: 13.4,
      text: 'Second line',
      words: [
        { id: 'w-3', text: 'Second', startSeconds: 11.84, endSeconds: 12.3 },
        { id: 'w-4', text: 'line', startSeconds: 12.4, endSeconds: 13.1 },
      ],
    },
  ]);
});

test('mapTranscriptSegments does not invent timings when provider words are absent', () => {
  assert.deepEqual(mapTranscriptSegments([
    { start_seconds: 0, end_seconds: 2, text: 'Legacy segment' },
  ], { segments: [{ text: 'Legacy segment' }] }), [
    { startSeconds: 0, endSeconds: 2, text: 'Legacy segment' },
  ]);
});
