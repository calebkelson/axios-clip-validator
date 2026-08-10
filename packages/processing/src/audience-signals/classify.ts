import { AUDIENCE_SIGNAL_CONFIG, type AudienceSignalConfig } from './constants.js';
import type { AudienceClassification, AudienceSignal, AudienceTrend } from './types.js';

export function classifyAudienceSignal(signal: AudienceSignal, options: { coveredByExistingClip?: boolean; trend?: AudienceTrend | null; config?: AudienceSignalConfig } = {}) {
  const config = options.config ?? AUDIENCE_SIGNAL_CONFIG;
  const trend = options.trend ?? signal.trend ?? null;
  const labels: AudienceClassification[] = [];
  const confidenceSufficient = signal.confidenceLabel !== 'low';
  const exitRiskHigh = signal.exitSafetyScore < 50;
  const exitRiskLow = signal.exitSafetyScore >= 67;
  if (signal.audienceSignal >= config.classifications.hot && confidenceSufficient && (signal.rewatchScore >= 75 || signal.retentionScore >= 85)) labels.push('hot');
  if (signal.audienceSignal >= config.classifications.proven && confidenceSufficient && (trend?.consecutiveStrongUpdates ?? 0) >= 3) labels.push('proven');
  if (signal.audienceSignal >= config.classifications.discovery && confidenceSufficient && options.coveredByExistingClip === false) labels.push('hidden_gem');
  if ((trend?.scoreDelta ?? 0) >= config.classifications.breakoutDelta && signal.audienceSignal >= 80 && confidenceSufficient) labels.push('breakout');
  else if ((trend?.scoreDelta ?? 0) >= config.classifications.emergingDelta && confidenceSufficient) labels.push('emerging');
  if ((trend?.scoreDelta ?? 0) <= config.classifications.coolingDelta && (trend?.previousScore ?? 0) >= config.classifications.hot) labels.push('cooling');
  if (signal.rewatchScore >= config.classifications.rewatchMagnet && (signal.raw.peakLocalRewatchLift ?? 0) >= 0.2) labels.push('rewatch_magnet');
  if (signal.entryScore >= config.classifications.strongEntry && signal.retentionScore >= 70) labels.push('strong_entry');
  if (signal.retentionScore >= config.classifications.stickyRetention && exitRiskLow) labels.push('sticky');
  if (exitRiskHigh && (signal.rewatchScore >= 80 || signal.retentionScore < 50)) labels.push('possible_confusion');
  if (!confidenceSufficient || signal.audienceSignal < config.classifications.watchMinimum) labels.push('watch');
  return [...new Set(labels)];
}

export function selectPrimaryAudienceClassification(signal: AudienceSignal, config: AudienceSignalConfig = AUDIENCE_SIGNAL_CONFIG): AudienceClassification | null {
  const classifications = new Set(signal.classifications ?? []);
  if (!classifications.size) return null;
  if (
    classifications.has('possible_confusion')
    && signal.rewatchScore >= config.primaryClassification.confusionOverrideRewatchMin
    && signal.exitSafetyScore <= config.primaryClassification.confusionOverrideExitSafetyMax
  ) return 'possible_confusion';
  return config.primaryClassification.priority.find((classification) => classifications.has(classification)) ?? null;
}

export function exitRiskLabel(exitSafetyScore: number) {
  if (exitSafetyScore >= 67) return 'low';
  if (exitSafetyScore >= 50) return 'medium';
  return 'high';
}
