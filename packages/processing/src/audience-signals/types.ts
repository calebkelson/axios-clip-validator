export type ConfidenceLabel = 'low' | 'medium' | 'high';

export type AudienceClassification =
  | 'hot'
  | 'hidden_gem'
  | 'emerging'
  | 'breakout'
  | 'rewatch_magnet'
  | 'strong_entry'
  | 'sticky'
  | 'proven'
  | 'watch'
  | 'cooling'
  | 'possible_confusion';

export type RetentionPoint = {
  videoId: string;
  videoTitle?: string | null;
  videoDurationSeconds?: number | null;
  segmentNumber: number;
  elapsedVideoTimeRatio: number;
  segmentStartSeconds: number;
  segmentEndSeconds: number;
  audienceWatchRatio: number;
  startedWatching: number;
  stoppedWatching: number;
  totalSegmentImpressions: number;
  relativeRetentionPerformance: number;
  queryStartDate?: string | null;
  queryEndDate?: string | null;
};

export type ScoredRetentionPoint = RetentionPoint & {
  localBaseline: number | null;
  localRewatchLift: number | null;
  rewatchScore: number;
  retentionScore: number;
  entryScore: number;
  stopRate: number | null;
  exitSafetyScore: number;
  confidence: number;
  confidenceLabel: ConfidenceLabel;
};

export type AudienceTrend = {
  scoreDelta: number | null;
  scoreDeltaPercent: number | null;
  previousScore: number | null;
  previousCollectedAt: string | null;
  daysTracked: number;
  consecutiveStrongUpdates: number;
};

export type AudienceSignal = {
  primaryClassification?: AudienceClassification | null;
  audienceSignal: number;
  rewatchScore: number;
  retentionScore: number;
  entryScore: number;
  exitSafetyScore: number;
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  totalSegmentImpressions: number;
  intervalCount: number;
  raw: {
    peakAudienceWatchRatio: number | null;
    medianAudienceWatchRatio: number | null;
    peakLocalRewatchLift: number | null;
    medianLocalRewatchLift: number | null;
    localBaseline: number | null;
    peakRelativeRetentionPerformance: number | null;
    medianRelativeRetentionPerformance: number | null;
    startIntervalEntryScore: number | null;
    endIntervalStopRate: number | null;
    normalStopRate: number | null;
    endingIntervalCount: number;
    followingIntervalCount: number;
  };
  trend?: AudienceTrend | null;
  classifications?: AudienceClassification[];
};

export type AudienceMoment = AudienceSignal & {
  id: string;
  videoId: string;
  startSeconds: number;
  endSeconds: number;
  overlappingClipIds: string[];
  overlapPercentage: number;
  coveredByExistingClip: boolean;
};
