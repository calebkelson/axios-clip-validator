export const AUDIENCE_SIGNAL_CONFIG = {
  weights: {
    rewatch: 0.35,
    retention: 0.30,
    entry: 0.20,
    exitSafety: 0.15,
  },
  confidence: {
    lowMax: 33,
    highMin: 67,
  },
  classifications: {
    hot: 85,
    proven: 82,
    emergingDelta: 8,
    breakoutDelta: 15,
    coolingDelta: -10,
    rewatchMagnet: 90,
    strongEntry: 90,
    stickyRetention: 85,
    watchMinimum: 65,
    discovery: 75,
    coverageOverlap: 0.5,
    minimumMomentSeconds: 5,
  },
  primaryClassification: {
    priority: ['breakout', 'hot', 'hidden_gem', 'emerging', 'proven', 'rewatch_magnet', 'strong_entry', 'sticky', 'possible_confusion', 'cooling', 'watch'],
    confusionOverrideRewatchMin: 80,
    confusionOverrideExitSafetyMax: 34,
  },
} as const;

export type AudienceSignalConfig = typeof AUDIENCE_SIGNAL_CONFIG;
