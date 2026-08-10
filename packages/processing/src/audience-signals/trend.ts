import type { AudienceSignal, AudienceTrend } from './types.js';

export type AudienceHistoryPoint = {
  audienceSignal: number;
  collectedAt: string;
  classifications?: string[] | null;
};

export function buildAudienceTrend(current: AudienceSignal, currentCollectedAt: string, history: AudienceHistoryPoint[]): AudienceTrend {
  const ordered = [...history].sort((left, right) => new Date(left.collectedAt).getTime() - new Date(right.collectedAt).getTime());
  const previous = ordered.at(-1) ?? null;
  const previousScore = previous?.audienceSignal ?? null;
  const scoreDelta = previousScore === null ? null : Number((current.audienceSignal - previousScore).toFixed(2));
  const scoreDeltaPercent = previousScore && previousScore !== 0 ? Number(((current.audienceSignal - previousScore) / previousScore * 100).toFixed(2)) : null;
  const currentTime = new Date(currentCollectedAt).getTime();
  const firstTime = ordered[0] ? new Date(ordered[0].collectedAt).getTime() : currentTime;
  const strongUpdates = [...ordered, { audienceSignal: current.audienceSignal, collectedAt: currentCollectedAt }];
  let consecutiveStrongUpdates = 0;
  for (let index = strongUpdates.length - 1; index >= 0; index -= 1) {
    if (strongUpdates[index].audienceSignal < 82) break;
    consecutiveStrongUpdates += 1;
  }
  return {
    scoreDelta,
    scoreDeltaPercent,
    previousScore,
    previousCollectedAt: previous?.collectedAt ?? null,
    daysTracked: Math.max(0, Math.round((currentTime - firstTime) / 86_400_000)),
    consecutiveStrongUpdates,
  };
}
