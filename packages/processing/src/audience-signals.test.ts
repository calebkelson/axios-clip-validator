import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAudienceSignal,
  detectAudienceMoments,
  scoreClipWindow,
  scoreRetentionTimeline,
  selectPrimaryAudienceClassification,
  type AudienceSignal,
  type ScoredRetentionPoint,
} from './audience-signals/index.js';

function signal(overrides: Partial<AudienceSignal> = {}): AudienceSignal {
  return {
    audienceSignal: 88,
    rewatchScore: 88,
    retentionScore: 88,
    entryScore: 72,
    exitSafetyScore: 82,
    confidence: 75,
    confidenceLabel: 'high',
    totalSegmentImpressions: 14200,
    intervalCount: 4,
    raw: {
      peakAudienceWatchRatio: 1.16,
      medianAudienceWatchRatio: 0.92,
      peakLocalRewatchLift: 0.41,
      medianLocalRewatchLift: 0.18,
      localBaseline: 0.82,
      peakRelativeRetentionPerformance: 0.93,
      medianRelativeRetentionPerformance: 0.84,
      startIntervalEntryScore: 72,
      endIntervalStopRate: 0.04,
      normalStopRate: 0.08,
      endingIntervalCount: 1,
      followingIntervalCount: 2,
    },
    trend: null,
    classifications: [],
    ...overrides,
  };
}

function point(segmentNumber: number, overrides: Partial<ScoredRetentionPoint> = {}): ScoredRetentionPoint {
  return {
    videoId: 'video-1',
    segmentNumber,
    elapsedVideoTimeRatio: segmentNumber / 10,
    segmentStartSeconds: (segmentNumber - 1) * 10,
    segmentEndSeconds: segmentNumber * 10,
    audienceWatchRatio: 0.9,
    startedWatching: 100,
    stoppedWatching: 10,
    totalSegmentImpressions: 1000,
    relativeRetentionPerformance: 0.85,
    localBaseline: 0.75,
    localRewatchLift: 0.2,
    rewatchScore: 88,
    retentionScore: 85,
    entryScore: 80,
    stopRate: 0.01,
    exitSafetyScore: 90,
    confidence: 80,
    confidenceLabel: 'high',
    ...overrides,
  };
}

test('retention normalization detects local rewatch lift instead of using raw ratio alone', () => {
  const points = Array.from({ length: 9 }, (_, index) => ({
    videoId: 'video-1', segmentNumber: index + 1, elapsedVideoTimeRatio: (index + 1) / 9,
    segmentStartSeconds: index * 10, segmentEndSeconds: (index + 1) * 10,
    audienceWatchRatio: index === 4 ? 1.16 : 0.78, startedWatching: index === 4 ? 180 : 100,
    stoppedWatching: 5, totalSegmentImpressions: 1000, relativeRetentionPerformance: 0.84,
  }));
  const scored = scoreRetentionTimeline(points);
  assert.ok((scored[4].localRewatchLift ?? 0) > 0.4);
  assert.equal(scored[4].rewatchScore, 100);
  assert.equal(scored[4].retentionScore, 84);
});

test('clip aggregation emphasizes entry at the start and exit behavior after the end', () => {
  const scored = [point(1, { entryScore: 40 }), point(2, { entryScore: 98 }), point(3, { exitSafetyScore: 20 }), point(4, { exitSafetyScore: 90 }), point(5, { exitSafetyScore: 90 })];
  const result = scoreClipWindow(scored, 10, 30);
  assert.ok(result);
  assert.equal(result.raw.followingIntervalCount, 2);
  assert.ok(result.entryScore > 70);
  assert.ok(result.exitSafetyScore < 70);
});

test('strong rewatch, retention and low exits classify as hot', () => assert.ok(classifyAudienceSignal(signal()).includes('hot')));
test('a strong uncovered moment classifies as a hidden gem', () => assert.ok(classifyAudienceSignal(signal(), { coveredByExistingClip: false }).includes('hidden_gem')));
test('a score increase of eight points classifies as emerging', () => assert.ok(classifyAudienceSignal(signal({ audienceSignal: 84 }), { trend: { scoreDelta: 8, scoreDeltaPercent: 10, previousScore: 76, previousCollectedAt: '2026-08-06T00:00:00.000Z', daysTracked: 1, consecutiveStrongUpdates: 0 } }).includes('emerging')));
test('a high score increase of fifteen points classifies as breakout', () => assert.ok(classifyAudienceSignal(signal({ audienceSignal: 88 }), { trend: { scoreDelta: 15, scoreDeltaPercent: 20, previousScore: 73, previousCollectedAt: '2026-08-06T00:00:00.000Z', daysTracked: 1, consecutiveStrongUpdates: 0 } }).includes('breakout')));
test('high rewatch with high exits flags possible confusion', () => assert.ok(classifyAudienceSignal(signal({ exitSafetyScore: 35 })).includes('possible_confusion')));
test('strong retention with low exit risk classifies as sticky', () => assert.ok(classifyAudienceSignal(signal({ rewatchScore: 65, retentionScore: 91, exitSafetyScore: 88 })).includes('sticky')));
test('high entry with healthy retention classifies as a strong entry point', () => assert.ok(classifyAudienceSignal(signal({ entryScore: 94, retentionScore: 78 })).includes('strong_entry')));
test('high score with low confidence remains watch', () => assert.ok(classifyAudienceSignal(signal({ confidence: 20, confidenceLabel: 'low' })).includes('watch')));
test('high score with three strong updates classifies as proven', () => assert.ok(classifyAudienceSignal(signal(), { trend: { scoreDelta: 2, scoreDeltaPercent: 2, previousScore: 86, previousCollectedAt: '2026-08-06T00:00:00.000Z', daysTracked: 3, consecutiveStrongUpdates: 3 } }).includes('proven')));
test('a material score drop after a hot update classifies as cooling', () => assert.ok(classifyAudienceSignal(signal({ audienceSignal: 78 }), { trend: { scoreDelta: -12, scoreDeltaPercent: -13, previousScore: 90, previousCollectedAt: '2026-08-06T00:00:00.000Z', daysTracked: 1, consecutiveStrongUpdates: 0 } }).includes('cooling')));
test('primary classification uses configured priority and returns one label', () => assert.equal(selectPrimaryAudienceClassification(signal({ classifications: ['hot', 'breakout', 'watch'] })), 'breakout'));
test('possible confusion overrides positive primary labels for strong replay and exits', () => assert.equal(selectPrimaryAudienceClassification(signal({ classifications: ['hot', 'possible_confusion'], rewatchScore: 92, exitSafetyScore: 20 })), 'possible_confusion'));
test('primary classification falls back to watch when it is the only label', () => assert.equal(selectPrimaryAudienceClassification(signal({ classifications: ['watch'] })), 'watch'));
test('full timeline detection groups adjacent strong intervals and records overlap', () => {
  const moments = detectAudienceMoments('video-1', [point(1), point(2), point(3)], [{ id: 'clip-1', startSeconds: 0, endSeconds: 30 }]);
  assert.equal(moments.length, 1);
  assert.equal(moments[0].coveredByExistingClip, true);
  assert.deepEqual(moments[0].overlappingClipIds, ['clip-1']);
});
