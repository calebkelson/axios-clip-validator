import { AUDIENCE_SIGNAL_CONFIG, type AudienceSignalConfig } from './constants.js';
import { clamp, confidenceLabel, median } from './normalize.js';
import type { AudienceSignal, ScoredRetentionPoint } from './types.js';

function round(value: number | null, digits = 4) {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

function medianNumber(values: number[]) {
  return median(values.filter(Number.isFinite));
}

export function scoreClipWindow(points: ScoredRetentionPoint[], startSeconds: number, endSeconds: number, config: AudienceSignalConfig = AUDIENCE_SIGNAL_CONFIG): AudienceSignal | null {
  if (!points.length || endSeconds <= startSeconds) return null;
  const overlapping = points.filter((point) => point.segmentEndSeconds > startSeconds && point.segmentStartSeconds < endSeconds);
  const selected = overlapping.length ? overlapping : [points.reduce((closest, point) => {
    const distance = point.segmentEndSeconds < startSeconds ? startSeconds - point.segmentEndSeconds : point.segmentStartSeconds - endSeconds;
    const closestDistance = closest.segmentEndSeconds < startSeconds ? startSeconds - closest.segmentEndSeconds : closest.segmentStartSeconds - endSeconds;
    return distance < closestDistance ? point : closest;
  }, points[0])];
  const startIndex = points.findIndex((point, index) => point.segmentStartSeconds <= startSeconds && (point.segmentEndSeconds > startSeconds || index === points.length - 1));
  const effectiveStartIndex = startIndex >= 0 ? startIndex : Math.max(0, points.findIndex((point) => point.segmentStartSeconds > startSeconds));
  const endIndex = points.findIndex((point) => point.segmentStartSeconds <= endSeconds && point.segmentEndSeconds >= endSeconds);
  const effectiveEndIndex = endIndex >= 0 ? endIndex : points.findIndex((point) => point.segmentEndSeconds >= endSeconds) >= 0 ? points.findIndex((point) => point.segmentEndSeconds >= endSeconds) : points.length - 1;
  const startPoint = points[effectiveStartIndex] ?? selected[0];
  const beforeStart = points[Math.max(0, effectiveStartIndex - 1)];
  const endingPoint = points[effectiveEndIndex] ?? selected.at(-1) ?? selected[0];
  const following = points.slice(effectiveEndIndex + 1, effectiveEndIndex + 4);
  const rewatchLifts = selected.map((point) => point.localRewatchLift).filter((value): value is number => value !== null);
  const localBaselines = selected.map((point) => point.localBaseline).filter((value): value is number => value !== null);
  const retentionValues = selected.map((point) => point.relativeRetentionPerformance);
  const endingSafety = endingPoint.exitSafetyScore;
  const followingSafety = following.length ? medianNumber(following.map((point) => point.exitSafetyScore)) ?? endingSafety : endingSafety;
  const exitSafetyScore = following.length ? endingSafety * 0.6 + followingSafety * 0.4 : endingSafety;
  const entryScore = beforeStart ? startPoint.entryScore * 0.7 + beforeStart.entryScore * 0.3 : startPoint.entryScore;
  const rewatchScore = medianNumber(selected.map((point) => point.rewatchScore)) ?? 50;
  const retentionScore = medianNumber(selected.map((point) => point.retentionScore)) ?? 50;
  const confidence = medianNumber(selected.map((point) => point.confidence)) ?? 0;
  const audienceSignal = clamp(
    config.weights.rewatch * rewatchScore
      + config.weights.retention * retentionScore
      + config.weights.entry * entryScore
      + config.weights.exitSafety * exitSafetyScore,
  );
  return {
    audienceSignal: round(audienceSignal, 2) ?? 0,
    rewatchScore: round(rewatchScore, 2) ?? 0,
    retentionScore: round(retentionScore, 2) ?? 0,
    entryScore: round(entryScore, 2) ?? 0,
    exitSafetyScore: round(exitSafetyScore, 2) ?? 0,
    confidence: round(confidence, 2) ?? 0,
    confidenceLabel: confidenceLabel(confidence, config),
    totalSegmentImpressions: Math.round(selected.reduce((sum, point) => sum + point.totalSegmentImpressions, 0)),
    intervalCount: selected.length,
    raw: {
      peakAudienceWatchRatio: round(Math.max(...selected.map((point) => point.audienceWatchRatio)), 4),
      medianAudienceWatchRatio: round(medianNumber(selected.map((point) => point.audienceWatchRatio)), 4),
      peakLocalRewatchLift: round(rewatchLifts.length ? Math.max(...rewatchLifts) : null),
      medianLocalRewatchLift: round(medianNumber(rewatchLifts)),
      localBaseline: round(medianNumber(localBaselines), 4),
      peakRelativeRetentionPerformance: round(Math.max(...retentionValues), 4),
      medianRelativeRetentionPerformance: round(medianNumber(retentionValues), 4),
      startIntervalEntryScore: round(startPoint.entryScore, 2),
      endIntervalStopRate: round(endingPoint.stopRate, 4),
      normalStopRate: round(medianNumber(points.map((point) => point.stopRate).filter((value): value is number => value !== null)), 4),
      endingIntervalCount: 1,
      followingIntervalCount: following.length,
    },
    trend: null,
    classifications: [],
  };
}
