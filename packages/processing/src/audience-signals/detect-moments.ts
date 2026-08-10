import { AUDIENCE_SIGNAL_CONFIG, type AudienceSignalConfig } from './constants.js';
import { classifyAudienceSignal } from './classify.js';
import { scoreClipWindow } from './score.js';
import type { AudienceMoment, ScoredRetentionPoint } from './types.js';

function intersection(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number) {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

export function detectAudienceMoments(videoId: string, points: ScoredRetentionPoint[], existingClips: Array<{ id: string; startSeconds: number; endSeconds: number }> = [], options: { previous?: Map<string, { audienceSignal: number; collectedAt: string; classifications?: string[] | null }[]>; collectedAt?: string; config?: AudienceSignalConfig } = {}): AudienceMoment[] {
  const config = options.config ?? AUDIENCE_SIGNAL_CONFIG;
  const collectedAt = options.collectedAt ?? new Date().toISOString();
  const regions: ScoredRetentionPoint[][] = [];
  for (const point of points) {
    if (point.rewatchScore * config.weights.rewatch + point.retentionScore * config.weights.retention + point.entryScore * config.weights.entry + point.exitSafetyScore * config.weights.exitSafety < config.classifications.discovery) continue;
    const previous = regions.at(-1);
    const previousPoint = previous?.at(-1);
    const adjacent = previousPoint && (point.segmentNumber <= previousPoint.segmentNumber + 1 || point.segmentStartSeconds <= previousPoint.segmentEndSeconds + Math.max(1, (point.segmentEndSeconds - point.segmentStartSeconds) * 0.2));
    if (previous && adjacent) previous.push(point);
    else regions.push([point]);
  }
  return regions
    .map((region) => {
      const startSeconds = region[0].segmentStartSeconds;
      const endSeconds = region.at(-1)?.segmentEndSeconds ?? startSeconds;
      if (endSeconds - startSeconds < config.classifications.minimumMomentSeconds) return null;
      const signal = scoreClipWindow(points, startSeconds, endSeconds, config);
      if (!signal) return null;
      const overlappingClipIds = existingClips.filter((clip) => intersection(startSeconds, endSeconds, clip.startSeconds, clip.endSeconds) > 0).map((clip) => clip.id);
      const overlapPercentage = existingClips.length ? Math.max(...existingClips.map((clip) => intersection(startSeconds, endSeconds, clip.startSeconds, clip.endSeconds) / Math.max(0.1, endSeconds - startSeconds))) : 0;
      const coveredByExistingClip = overlapPercentage >= config.classifications.coverageOverlap;
      const id = `${videoId}:${startSeconds.toFixed(3)}-${endSeconds.toFixed(3)}`;
      const previousHistory = options.previous?.get(id) ?? [];
      const previous = previousHistory.at(-1);
      const scoreDelta = previous ? Number((signal.audienceSignal - previous.audienceSignal).toFixed(2)) : null;
      const trend = {
        scoreDelta,
        scoreDeltaPercent: previous && previous.audienceSignal ? Number(((signal.audienceSignal - previous.audienceSignal) / previous.audienceSignal * 100).toFixed(2)) : null,
        previousScore: previous?.audienceSignal ?? null,
        previousCollectedAt: previous?.collectedAt ?? null,
        daysTracked: previous ? Math.max(0, Math.round((new Date(collectedAt).getTime() - new Date(previous.collectedAt).getTime()) / 86_400_000)) : 0,
        consecutiveStrongUpdates: (() => {
          const recent = [...previousHistory, { audienceSignal: signal.audienceSignal, collectedAt }].slice(-10).reverse();
          const firstWeak = recent.findIndex((item) => item.audienceSignal < 82);
          return firstWeak === -1 ? recent.length : firstWeak;
        })(),
      };
      signal.trend = trend;
      signal.classifications = classifyAudienceSignal(signal, { coveredByExistingClip, trend, config });
      return { ...signal, id, videoId, startSeconds, endSeconds, overlappingClipIds, overlapPercentage: Number(overlapPercentage.toFixed(4)), coveredByExistingClip };
    })
    .filter((moment): moment is AudienceMoment => Boolean(moment));
}
