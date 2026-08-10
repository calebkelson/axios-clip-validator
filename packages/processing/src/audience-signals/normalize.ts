import { AUDIENCE_SIGNAL_CONFIG, type AudienceSignalConfig } from './constants.js';
import type { ConfidenceLabel, RetentionPoint, ScoredRetentionPoint } from './types.js';

export function clamp(value: number, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}

export function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function percentileRank(value: number, values: number[]) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length || !Number.isFinite(value)) return 50;
  if (finite.length === 1) return 50;
  const below = finite.filter((item) => item < value).length;
  const equal = finite.filter((item) => item === value).length;
  return clamp(((below + Math.max(0, equal - 1) / 2) / (finite.length - 1)) * 100);
}

export function confidenceLabel(confidence: number, config: AudienceSignalConfig = AUDIENCE_SIGNAL_CONFIG): ConfidenceLabel {
  if (confidence >= config.confidence.highMin) return 'high';
  if (confidence > config.confidence.lowMax) return 'medium';
  return 'low';
}

function numberOrZero(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function normalizeRetentionPoints(points: RetentionPoint[]) {
  return points
    .map((point) => ({
      ...point,
      segmentNumber: Math.max(1, Math.trunc(numberOrZero(point.segmentNumber))),
      elapsedVideoTimeRatio: numberOrZero(point.elapsedVideoTimeRatio),
      segmentStartSeconds: Math.max(0, numberOrZero(point.segmentStartSeconds)),
      segmentEndSeconds: Math.max(0, numberOrZero(point.segmentEndSeconds)),
      audienceWatchRatio: Math.max(0, numberOrZero(point.audienceWatchRatio)),
      startedWatching: Math.max(0, numberOrZero(point.startedWatching)),
      stoppedWatching: Math.max(0, numberOrZero(point.stoppedWatching)),
      totalSegmentImpressions: Math.max(0, numberOrZero(point.totalSegmentImpressions)),
      relativeRetentionPerformance: Math.max(0, numberOrZero(point.relativeRetentionPerformance)),
    }))
    .filter((point) => point.segmentEndSeconds >= point.segmentStartSeconds)
    .sort((left, right) => left.segmentNumber - right.segmentNumber || left.segmentStartSeconds - right.segmentStartSeconds);
}

export function scoreRetentionTimeline(points: RetentionPoint[], referenceImpressions?: number[], config: AudienceSignalConfig = AUDIENCE_SIGNAL_CONFIG): ScoredRetentionPoint[] {
  const normalized = normalizeRetentionPoints(points);
  if (!normalized.length) return [];
  const impressionReference = referenceImpressions?.filter(Number.isFinite).length ? referenceImpressions : normalized.map((point) => point.totalSegmentImpressions);
  const retentionValues = normalized.map((point) => point.relativeRetentionPerformance);
  const entryValues = normalized.map((point) => point.startedWatching);
  const stopRates = normalized.map((point) => point.totalSegmentImpressions > 0 ? point.stoppedWatching / point.totalSegmentImpressions : 0);
  const normalStopRate = median(stopRates) ?? 0;
  const rewatchLifts: Array<number | null> = normalized.map((point, index) => {
    const nearby = normalized
      .slice(Math.max(0, index - 4), index + 5)
      .filter((_, nearbyIndex) => Math.max(0, index - 4) + nearbyIndex !== index)
      .map((candidate) => candidate.audienceWatchRatio)
      .filter((value) => value > 0);
    const baseline = median(nearby);
    return baseline && baseline > 0 ? point.audienceWatchRatio / baseline - 1 : null;
  });
  const liftValues = rewatchLifts.filter((value): value is number => value !== null);
  return normalized.map((point, index) => {
    const localBaseline = rewatchLifts[index] === null ? null : point.audienceWatchRatio / (1 + (rewatchLifts[index] ?? 0));
    const localRewatchLift = rewatchLifts[index];
    const stopRate = point.totalSegmentImpressions > 0 ? point.stoppedWatching / point.totalSegmentImpressions : null;
    const exitSafetyScore = stopRate === null ? 50 : clamp(100 - percentileRank(stopRate, stopRates));
    const confidence = percentileRank(Math.log1p(point.totalSegmentImpressions), impressionReference.map((value) => Math.log1p(Math.max(0, value))));
    return {
      ...point,
      localBaseline,
      localRewatchLift,
      rewatchScore: localRewatchLift === null ? 50 : percentileRank(localRewatchLift, liftValues),
      retentionScore: clamp(point.relativeRetentionPerformance * 100),
      entryScore: percentileRank(point.startedWatching, entryValues),
      stopRate,
      exitSafetyScore,
      confidence,
      confidenceLabel: confidenceLabel(confidence, config),
      _normalStopRate: normalStopRate,
      _retentionValues: retentionValues,
    } as ScoredRetentionPoint & { _normalStopRate: number; _retentionValues: number[] };
  });
}

export function scoreRetentionDataset(groups: Map<string, RetentionPoint[]>, config: AudienceSignalConfig = AUDIENCE_SIGNAL_CONFIG) {
  const referenceImpressions = [...groups.values()].flat().map((point) => Math.max(0, point.totalSegmentImpressions));
  return new Map([...groups.entries()].map(([videoId, points]) => [videoId, scoreRetentionTimeline(points, referenceImpressions, config)]));
}
