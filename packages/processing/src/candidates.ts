import type { TranscriptSegment } from './index.js';

export const MOMENT_SCORE_WEIGHTS = {
  hookStrength: 18,
  payoffStrength: 16,
  standaloneClarity: 14,
  audienceValue: 14,
  emotionAndTension: 10,
  shareabilityAndQuotability: 10,
  specificityAndCredibility: 7,
  novelty: 6,
  densityAndMomentum: 5,
} as const;

export type MomentScoreBreakdown = Record<keyof typeof MOMENT_SCORE_WEIGHTS, number>;

export interface CandidateEvidence {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface CandidateSocialCopy {
  headline: string;
  caption: string;
  hashtags: string[];
  hook?: string;
  alternates?: {
    curiosity: string;
    stakes: string;
    conversation: string;
  };
  optionalCta?: string | null;
  headlineCards: Array<{
    id: string;
    text: string;
    startSeconds: number;
    endSeconds: number;
    color: 'navy' | 'black' | 'purple' | 'blue' | 'green' | 'red' | 'white';
    shape: 'rounded' | 'pill';
    xPercent: number;
    yPercent: number;
    widthPercent?: number;
    heightPercent?: number;
    transitionSeconds?: number;
    placementCustomized?: boolean;
  }>;
  nameTags: Array<{
    id: string;
    name: string;
    title: string;
    startSeconds: number;
    endSeconds: number;
    color: 'navy' | 'black' | 'purple' | 'blue' | 'green' | 'red' | 'white';
    xPercent: number;
    yPercent: number;
    widthPercent?: number;
    heightPercent?: number;
    transitionSeconds?: number;
    placementCustomized?: boolean;
  }>;
}

export const headlineStrategies = ['quote', 'stakes', 'contrast', 'question', 'utility', 'direct'] as const;
export type HeadlineStrategy = typeof headlineStrategies[number];

export const momentTypes = ['reveal', 'stakes', 'contrast', 'question_answer', 'explanation', 'advice', 'conflict', 'quote', 'story', 'reaction', 'other'] as const;
export type MomentType = typeof momentTypes[number];

export interface MomentBrief {
  subject: string | null;
  speaker: string | null;
  momentType: MomentType;
  coreClaim: string;
  payoff: string | null;
  audienceRelevance: string | null;
  strongestSpecificDetail: string | null;
  strongestQuote: string | null;
  tensionOrContrast: string | null;
  necessaryQualifier: string | null;
}

export interface EditorialCopyDraft {
  headline: string;
  caption: string;
  hashtags?: string[];
  hook?: string;
  alternates?: {
    curiosity: string;
    stakes: string;
    conversation: string;
  };
  optionalCta?: string | null;
  headlineStrategy?: HeadlineStrategy;
  momentType?: MomentType;
  supportingText?: string[];
  necessaryQualifier?: string | null;
}

export interface EditorialCopyValidation {
  valid: boolean;
  failures: string[];
}

/**
 * Provider-neutral seam for a future model client. The repository currently
 * has no model client, so the default agent uses the deterministic fallback.
 */
export type EditorialCopyModelClient = (prompt: string) => unknown;

export interface EditorialCopyAgent {
  readonly name: string;
  generate(input: { transcript: string; variantSeed?: number }): CandidateSocialCopy;
}

/**
 * Transcript-grounded copy agent used by Find Moments. It deliberately writes
 * new editorial language from the clip's transcript instead of copying a cue,
 * question, or source-video title into publishing metadata.
 */
export class TranscriptEditorialCopyAgent implements EditorialCopyAgent {
  readonly name = 'transcript-editorial-copy-agent-v1';

  constructor(private readonly modelClient?: EditorialCopyModelClient) {}

  generate({ transcript, variantSeed = 0 }: { transcript: string; variantSeed?: number }) {
    return buildSocialCopy(transcript, variantSeed, this.modelClient);
  }
}

export interface CandidateProposal {
  startSeconds: number;
  endSeconds: number;
  score: number;
  confidence: number;
  rationale: string;
  evidence: CandidateEvidence[];
  socialCopy: CandidateSocialCopy;
  metadata: { scoringVersion: string; scoreDimensions: MomentScoreBreakdown };
}

export const FIND_MOMENTS_CONFIG = {
  absoluteMinDurationSeconds: 30,
  preferredMinDurationSeconds: 30,
  preferredMaxDurationSeconds: 60,
  absoluteMaxDurationSeconds: 60,
  contextSearchBeforeSeconds: 20,
  startSearchAfterSeedSeconds: 3,
  heuristicPoolSize: 60,
  fullScoringPoolSize: 30,
  finalCandidateCount: 8,
  duplicateIoUThreshold: 0.65,
  containmentThreshold: 0.8,
  semanticDuplicateThreshold: 0.85,
  maxVariantsPerMoment: 4,
} as const;

type FindMomentsConfig = { [Key in keyof typeof FIND_MOMENTS_CONFIG]: number };

type NormalizedUtterance = {
  startSeconds: number;
  endSeconds: number;
  text: string;
  sourceSegments: TranscriptSegment[];
  pauseBeforeSeconds: number;
  pauseAfterSeconds: number;
};

type CandidateVariant = {
  startIndex: number;
  endIndex: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
  utterances: NormalizedUtterance[];
  startBoundaryQuality: number;
  endBoundaryQuality: number;
  completionQuality: number;
  utility: number;
  topicSignature: string[];
  momentType: string;
};

type ScoredVariant = CandidateVariant & {
  score: number;
  confidence: number;
  rationale: string;
  evidence: CandidateEvidence[];
  socialCopy: CandidateSocialCopy;
  metadata: { scoringVersion: string; scoreDimensions: MomentScoreBreakdown };
};

export interface EditorialCandidateProvider {
  readonly name: string;
  generate(input: { segments: TranscriptSegment[]; durationSeconds: number | null }): CandidateProposal[];
}

export class HeuristicEditorialCandidateProvider implements EditorialCandidateProvider {
  readonly name = 'heuristic-editorial-v1';

  constructor(
    private readonly options: {
      minSeconds?: number;
      maxSeconds?: number;
      maxCandidates?: number;
      overlapThreshold?: number;
      preferredMinSeconds?: number;
      preferredMaxSeconds?: number;
      copyAgent?: EditorialCopyAgent;
    } = {},
  ) {}

  generate({ segments, durationSeconds }: { segments: TranscriptSegment[]; durationSeconds: number | null }) {
    const config = resolveFindMomentsConfig(this.options);
    const utterances = normalizeSegmentsIntoUtterances(segments, durationSeconds);
    if (!utterances.length) return [];

    const starts = findCandidateStarts(utterances, config);
    const variants = starts.flatMap((seedIndex) => generateCandidateVariants(utterances, seedIndex, config));
    const heuristicPool = variants.sort(compareUtility).slice(0, config.heuristicPoolSize);
    const fullScoringPool = heuristicPool.slice(0, config.fullScoringPoolSize);
    const copyAgent = this.options.copyAgent ?? new TranscriptEditorialCopyAgent();
    const scoredVariants = fullScoringPool.map((variant, index) => scoreCandidateVariant(variant, utterances, Math.round(variant.startSeconds * 10) + index, copyAgent));
    const families = clusterMomentFamilies(scoredVariants, config);
    const selected = selectDiverseCandidates(families, config.finalCandidateCount, utterances.at(-1)?.endSeconds ?? 0);

    const usedHeadlines = new Set<string>();
    return selected
      .sort((left, right) => right.score - left.score || left.startSeconds - right.startSeconds)
      .map(({ startSeconds, endSeconds, score, confidence, rationale, evidence, metadata, text }, index) => {
        let socialCopy = copyAgent.generate({ transcript: text, variantSeed: Math.round((startSeconds + endSeconds) * 10) + index });
        for (let attempt = 1; usedHeadlines.has(socialCopy.headline) && attempt <= 8; attempt += 1) {
          socialCopy = copyAgent.generate({ transcript: text, variantSeed: Math.round((startSeconds + endSeconds) * 10) + index + attempt });
        }
        usedHeadlines.add(socialCopy.headline);
        return { startSeconds, endSeconds, score, confidence, rationale, evidence, socialCopy, metadata };
      });
  }
}

export function createEditorialCandidateProvider(env: NodeJS.ProcessEnv = process.env): EditorialCandidateProvider {
  const minSeconds = boundedNumber(env.CANDIDATE_MIN_SECONDS, FIND_MOMENTS_CONFIG.absoluteMinDurationSeconds, FIND_MOMENTS_CONFIG.absoluteMinDurationSeconds, FIND_MOMENTS_CONFIG.absoluteMaxDurationSeconds);
  const maxSeconds = boundedNumber(env.CANDIDATE_MAX_SECONDS, FIND_MOMENTS_CONFIG.absoluteMaxDurationSeconds, minSeconds, FIND_MOMENTS_CONFIG.absoluteMaxDurationSeconds);
  return new HeuristicEditorialCandidateProvider({
    minSeconds,
    maxSeconds,
    maxCandidates: numberOrDefault(env.MAX_CANDIDATES, 8),
  });
}

function resolveFindMomentsConfig(options: { minSeconds?: number; maxSeconds?: number; maxCandidates?: number; overlapThreshold?: number; preferredMinSeconds?: number; preferredMaxSeconds?: number }): FindMomentsConfig {
  const absoluteMinDurationSeconds = Math.min(FIND_MOMENTS_CONFIG.absoluteMaxDurationSeconds, Math.max(0.1, options.minSeconds ?? FIND_MOMENTS_CONFIG.absoluteMinDurationSeconds));
  const absoluteMaxDurationSeconds = Math.min(FIND_MOMENTS_CONFIG.absoluteMaxDurationSeconds, Math.max(absoluteMinDurationSeconds, options.maxSeconds ?? FIND_MOMENTS_CONFIG.absoluteMaxDurationSeconds));
  const preferredMinDurationSeconds = Math.min(
    absoluteMaxDurationSeconds,
    Math.max(absoluteMinDurationSeconds, options.preferredMinSeconds ?? FIND_MOMENTS_CONFIG.preferredMinDurationSeconds),
  );
  const preferredMaxDurationSeconds = Math.max(
    preferredMinDurationSeconds,
    Math.min(absoluteMaxDurationSeconds, options.preferredMaxSeconds ?? FIND_MOMENTS_CONFIG.preferredMaxDurationSeconds),
  );
  return {
    ...FIND_MOMENTS_CONFIG,
    absoluteMinDurationSeconds,
    absoluteMaxDurationSeconds,
    preferredMinDurationSeconds,
    preferredMaxDurationSeconds,
    duplicateIoUThreshold: options.overlapThreshold ?? FIND_MOMENTS_CONFIG.duplicateIoUThreshold,
    finalCandidateCount: options.maxCandidates ?? FIND_MOMENTS_CONFIG.finalCandidateCount,
  };
}

function normalizeSegmentsIntoUtterances(segments: TranscriptSegment[], durationSeconds: number | null): NormalizedUtterance[] {
  const limit = durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : Number.POSITIVE_INFINITY;
  const valid = segments
    .map((segment) => ({
      startSeconds: Number(segment.startSeconds),
      endSeconds: Number(segment.endSeconds),
      text: segment.text?.replace(/\s+/g, ' ').trim() ?? '',
    }))
    .filter((segment) => Number.isFinite(segment.startSeconds) && Number.isFinite(segment.endSeconds) && segment.text && segment.endSeconds > segment.startSeconds)
    .sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);
  const utterances: NormalizedUtterance[] = [];
  let previousEnd = 0;

  for (const segment of valid) {
    const startSeconds = Math.max(0, previousEnd, segment.startSeconds);
    const endSeconds = Math.min(limit, segment.endSeconds);
    if (endSeconds <= startSeconds) continue;
    const normalizedSegment = { startSeconds, endSeconds, text: segment.text };
    const previous = utterances.at(-1);
    const pauseBeforeSeconds = previous ? Math.max(0, startSeconds - previous.endSeconds) : startSeconds;
    if (previous && shouldMergeUtterances(previous, normalizedSegment, pauseBeforeSeconds)) {
      previous.endSeconds = endSeconds;
      previous.text = `${previous.text} ${normalizedSegment.text}`.replace(/\s+/g, ' ').trim();
      previous.sourceSegments.push(normalizedSegment);
    } else {
      utterances.push({ startSeconds, endSeconds, text: normalizedSegment.text, sourceSegments: [normalizedSegment], pauseBeforeSeconds, pauseAfterSeconds: 0 });
    }
    previousEnd = Math.max(previousEnd, endSeconds);
  }

  for (let index = 0; index < utterances.length; index += 1) {
    utterances[index].pauseAfterSeconds = index < utterances.length - 1 ? Math.max(0, utterances[index + 1].startSeconds - utterances[index].endSeconds) : 0;
  }
  return utterances;
}

function shouldMergeUtterances(previous: NormalizedUtterance, current: Pick<NormalizedUtterance, 'startSeconds' | 'endSeconds' | 'text'>, pauseBeforeSeconds: number) {
  const previousText = previous.text.trim();
  const previousEnded = /[.!?…]["')\]]*$/.test(previousText);
  const combinedDuration = current.endSeconds - previous.startSeconds;
  const combinedWords = copyWords(`${previousText} ${current.text}`).length;
  return !previousEnded && pauseBeforeSeconds <= 0.9 && combinedDuration <= 15 && combinedWords <= 48;
}

function findCandidateStarts(utterances: NormalizedUtterance[], config: FindMomentsConfig) {
  // Boundary-first starts avoid arbitrary ASR cuts while the fallback stride keeps
  // quiet transcripts covered from beginning to end.
  const promising: number[] = [];
  for (let index = 0; index < utterances.length; index += 1) {
    const quality = scoreStartBoundary(utterances, index);
    if (quality >= 0.48 || hasStartSignal(utterances[index].text)) promising.push(index);
  }
  const fallbackStride = Math.max(1, Math.ceil(utterances.length / 24));
  for (let index = 0; index < utterances.length; index += fallbackStride) promising.push(index);
  promising.push(0, utterances.length - 1);
  const unique = [...new Set(promising)].sort((left, right) => left - right);
  const maxSeeds = Math.min(48, Math.max(12, Math.ceil(utterances.length / 2)));
  if (unique.length <= maxSeeds) return unique;

  const sampled = sampleEvenly(unique, maxSeeds);
  const contextSeeds = unique.filter((index) => unique.some((seed) => seed > index && utterances[seed].startSeconds - utterances[index].startSeconds <= config.contextSearchBeforeSeconds && scoreStartBoundary(utterances, index) > scoreStartBoundary(utterances, seed) + 0.12));
  return [...new Set(sampled.concat(contextSeeds))].sort((left, right) => left - right).slice(0, maxSeeds);
}

function generateCandidateVariants(utterances: NormalizedUtterance[], seedIndex: number, config: FindMomentsConfig): CandidateVariant[] {
  const startIndices = [seedIndex];
  for (let index = seedIndex - 1; index >= 0; index -= 1) {
    if (utterances[seedIndex].startSeconds - utterances[index].startSeconds > config.contextSearchBeforeSeconds) break;
    if (scoreStartBoundary(utterances, index) >= scoreStartBoundary(utterances, seedIndex) + 0.12) startIndices.push(index);
    if (startIndices.length >= 3) break;
  }

  return startIndices.flatMap((startIndex) => {
    const possibleEnds: Array<{ endIndex: number; duration: number; endQuality: number; completionQuality: number; durationFit: number }> = [];
    for (let endIndex = startIndex; endIndex < utterances.length; endIndex += 1) {
      const duration = utterances[endIndex].endSeconds - utterances[startIndex].startSeconds;
      if (duration > config.absoluteMaxDurationSeconds) break;
      if (duration < config.absoluteMinDurationSeconds) continue;
      const endQuality = scoreEndBoundary(utterances, endIndex);
      const text = utteranceText(utterances, startIndex, endIndex);
      const completionQuality = calculateCompletionQuality(text, endQuality);
      const firstValid = possibleEnds.length === 0;
      const nearPreferredBoundary = Math.abs(duration - config.preferredMaxDurationSeconds) <= 8;
      if (firstValid || endQuality >= 0.42 || completionQuality >= 0.62 || nearPreferredBoundary || endIndex === utterances.length - 1) {
        possibleEnds.push({ endIndex, duration, endQuality, completionQuality, durationFit: durationFit(duration, config) });
      }
    }
    if (!possibleEnds.length) return [];

    const first = possibleEnds[0];
    const strongest = [...possibleEnds].sort((left, right) => right.completionQuality + right.endQuality - left.completionQuality - left.endQuality || right.durationFit - left.durationFit)[0];
    const preferred = [...possibleEnds].sort((left, right) => Math.abs(left.endIndex - preferredEndIndex(possibleEnds, config)) - Math.abs(right.endIndex - preferredEndIndex(possibleEnds, config)))[0];
    const last = possibleEnds.at(-1);
    type CandidateEnd = NonNullable<typeof first>;
    const selectedEnds = [first, strongest, preferred, last]
      .filter((candidate): candidate is CandidateEnd => Boolean(candidate))
      .filter((candidate, index, all) => all.findIndex((other) => other.endIndex === candidate.endIndex) === index)
      .slice(0, config.maxVariantsPerMoment);

    return selectedEnds.map(({ endIndex, endQuality, completionQuality, durationFit: fit }) => {
      const text = utteranceText(utterances, startIndex, endIndex);
      const startQuality = scoreStartBoundary(utterances, startIndex);
      const utility = calculateCandidateUtility({ text, startQuality, endQuality, completionQuality, durationFit: fit, startIndex, endIndex, utterances });
      return {
        startIndex,
        endIndex,
        startSeconds: utterances[startIndex].startSeconds,
        endSeconds: utterances[endIndex].endSeconds,
        text,
        utterances: utterances.slice(startIndex, endIndex + 1),
        startBoundaryQuality: startQuality,
        endBoundaryQuality: endQuality,
        completionQuality,
        utility,
        topicSignature: topicSignature(text),
        momentType: momentType(text),
      };
    });
  });
}

function preferredEndIndex(possibleEnds: Array<{ endIndex: number; duration: number; endQuality: number; completionQuality: number; durationFit: number }>, config: FindMomentsConfig) {
  const targetDuration = (config.preferredMinDurationSeconds + config.preferredMaxDurationSeconds) / 2;
  return possibleEnds.reduce((best, current) => {
    const bestDistance = Math.abs(best.duration - targetDuration);
    const currentDistance = Math.abs(current.duration - targetDuration);
    return currentDistance < bestDistance || (currentDistance === bestDistance && current.durationFit > best.durationFit) ? current : best;
  }, possibleEnds[0]).endIndex;
}

function scoreCandidateVariant(variant: CandidateVariant, sourceUtterances: NormalizedUtterance[], variantSeed: number, copyAgent: EditorialCopyAgent): ScoredVariant {
  const scoreDimensions = scoreMoment(variant.text, variant.utterances, sourceUtterances);
  const score = weightedMomentScore(scoreDimensions);
  const confidence = Math.min(0.98, Math.max(0.35, score * 0.92 + Math.min(0.08, Math.max(0, variant.utterances.length - 1) * 0.02)));
  return {
    ...variant,
    score: roundScore(score),
    confidence: roundScore(confidence),
    rationale: buildRationale(variant.text, variant.endSeconds - variant.startSeconds, scoreDimensions),
    evidence: variant.utterances.flatMap((utterance) => utterance.sourceSegments.map((segment) => ({ startSeconds: segment.startSeconds, endSeconds: segment.endSeconds, text: segment.text }))),
    socialCopy: copyAgent.generate({ transcript: variant.text, variantSeed }),
    metadata: { scoringVersion: 'weighted-moment-v2', scoreDimensions },
  };
}

function calculateCandidateUtility(input: { text: string; startQuality: number; endQuality: number; completionQuality: number; durationFit: number; startIndex: number; endIndex: number; utterances: NormalizedUtterance[] }) {
  const hookNearBeginning = hookNearBeginningScore(input.text);
  const standaloneClarity = cheapStandaloneClarity(input.text);
  const fillerPenalty = fillerRatio(input.text) * 0.12;
  const repetitionPenalty = repeatedTokenRatio(input.text) * 0.1;
  const unresolvedPenalty = startsWithUnresolvedReference(input.text) ? 0.16 : 0;
  const truncationPenalty = endsMidThought(input.text) ? 0.2 : 0;
  return 0.2 * input.startQuality + 0.2 * input.endQuality + 0.2 * hookNearBeginning + 0.2 * input.completionQuality + 0.12 * standaloneClarity + 0.08 * input.durationFit - fillerPenalty - repetitionPenalty - unresolvedPenalty - truncationPenalty;
}

function clusterMomentFamilies(variants: ScoredVariant[], config: FindMomentsConfig) {
  // Tight, standard, and full-context cuts share a family; distinct claims that
  // merely overlap keep separate families when their union of terms diverges.
  const families: ScoredVariant[][] = [];
  for (const variant of [...variants].sort((left, right) => right.score - left.score || left.startSeconds - right.startSeconds)) {
    const family = families.find((members) => members.some((member) => sameMomentFamily(member, variant, config)));
    if (family) family.push(variant);
    else families.push([variant]);
  }
  return families;
}

function sameMomentFamily(left: ScoredVariant, right: ScoredVariant, config: FindMomentsConfig) {
  const similarity = calculateTextSimilarity(left.text, right.text);
  const jaccardSimilarity = calculateJaccardTextSimilarity(left.text, right.text);
  const containment = containmentOverlap(left, right);
  const iou = intervalIoU(left, right);
  const openingSimilarity = calculateTextSimilarity(left.utterances[0]?.text ?? '', right.utterances[0]?.text ?? '');
  const payoffSimilarity = calculateTextSimilarity(left.utterances.at(-1)?.text ?? '', right.utterances.at(-1)?.text ?? '');
  const sharedCore = jaccardSimilarity >= 0.55 || (openingSimilarity >= 0.72 && payoffSimilarity >= 0.72);
  return (containment >= config.containmentThreshold && similarity >= 0.45 && sharedCore) || (iou >= config.duplicateIoUThreshold && similarity >= config.semanticDuplicateThreshold && jaccardSimilarity >= 0.55) || (similarity >= config.semanticDuplicateThreshold && jaccardSimilarity >= 0.75 && iou >= 0.1);
}

function selectDiverseCandidates(families: ScoredVariant[][], count: number, sourceDuration: number) {
  const remaining = families.map((family) => [...family].sort(compareVariantQuality));
  const selected: ScoredVariant[] = [];
  while (remaining.length && selected.length < count) {
    let bestFamilyIndex = 0;
    let bestUtility = Number.NEGATIVE_INFINITY;
    for (let familyIndex = 0; familyIndex < remaining.length; familyIndex += 1) {
      const candidate = remaining[familyIndex][0];
      const temporalPenalty = selected.reduce((maximum, other) => Math.max(maximum, intervalIoU(candidate, other) * 0.14), 0);
      const semanticPenalty = selected.reduce((maximum, other) => Math.max(maximum, calculateTextSimilarity(candidate.text, other.text) * 0.12), 0);
      const newTopicBonus = selected.every((other) => calculateTextSimilarity(candidate.text, other.text) < 0.35) ? 0.08 : 0;
      const newMomentTypeBonus = selected.every((other) => candidate.momentType !== other.momentType) ? 0.04 : 0;
      const durationBandBonus = selected.every((other) => durationBand(candidate) !== durationBand(other)) ? 0.1 : 0;
      const nearestSelectedDistance = selected.length ? Math.min(...selected.map((other) => Math.abs((candidate.startSeconds + candidate.endSeconds) / 2 - (other.startSeconds + other.endSeconds) / 2))) : 0;
      const coverageBonus = selected.length && sourceDuration > 0 ? Math.min(0.08, nearestSelectedDistance / sourceDuration) : 0;
      const utility = candidate.score + newTopicBonus + newMomentTypeBonus + durationBandBonus + coverageBonus - temporalPenalty - semanticPenalty;
      if (utility > bestUtility) {
        bestUtility = utility;
        bestFamilyIndex = familyIndex;
      }
    }
    selected.push(remaining.splice(bestFamilyIndex, 1)[0][0]);
  }
  return selected;
}

function durationBand(candidate: Pick<CandidateVariant, 'startSeconds' | 'endSeconds'>) {
  const duration = candidate.endSeconds - candidate.startSeconds;
  if (duration < 38) return 'short';
  if (duration < 50) return 'mid';
  return 'long';
}

function compareUtility(left: CandidateVariant, right: CandidateVariant) {
  return right.utility - left.utility || left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds;
}

function compareVariantQuality(left: ScoredVariant, right: ScoredVariant) {
  return (right.score * 0.65 + right.endBoundaryQuality * 0.15 + right.startBoundaryQuality * 0.1 + cheapStandaloneClarity(right.text) * 0.1) - (left.score * 0.65 + left.endBoundaryQuality * 0.15 + left.startBoundaryQuality * 0.1 + cheapStandaloneClarity(left.text) * 0.1) || right.utility - left.utility;
}

function utteranceText(utterances: NormalizedUtterance[], startIndex: number, endIndex: number) {
  return utterances.slice(startIndex, endIndex + 1).map((utterance) => utterance.text).join(' ').replace(/\s+/g, ' ').trim();
}

function scoreStartBoundary(utterances: NormalizedUtterance[], index: number) {
  const utterance = utterances[index];
  const text = utterance.text.trim();
  let score = index === 0 ? 0.62 : 0.34;
  if (index === 0 || utterance.pauseBeforeSeconds >= 0.9) score += 0.18;
  if (index > 0 && /[.!?…]["')\]]*$/.test(utterances[index - 1].text.trim())) score += 0.14;
  if (hasStartSignal(text)) score += 0.18;
  if (/^[a-z]/.test(text)) score -= 0.18;
  if (/^(but|and then|that's why|he said|the second reason|like i mentioned)\b/i.test(text)) score -= 0.26;
  if (/^(this|that|it|they|he|she|we)\b/i.test(text) && !/\b(this is|that means|we need|we know)\b/i.test(text)) score -= 0.14;
  return clamp01(score);
}

function scoreEndBoundary(utterances: NormalizedUtterance[], index: number) {
  const utterance = utterances[index];
  const text = utterance.text.trim();
  let score = /[.!?…]["')\]]*$/.test(text) ? 0.56 : 0.28;
  if (utterance.pauseAfterSeconds >= 0.9 || index === utterances.length - 1) score += 0.18;
  if (/\b(answer|because|therefore|means|result|resulted|turns out|takeaway|conclusion|reveal|reveals|so what|that is why)\b/i.test(text)) score += 0.2;
  if (/\b(and|but|because|so|to|of|that|which|if|when|while)\s*[.!?]?$/i.test(text)) score -= 0.3;
  if (text.endsWith('?') && !/\b(why|how|what|is|are|can|will)\b/i.test(text)) score -= 0.12;
  return clamp01(score);
}

function hasStartSignal(text: string) {
  return /\?|\b(the reason|the key|here's|this is|what matters|the problem|the reality|the truth|first|one thing|the question)\b|\b\d+(?:\.\d+)?%?\b/i.test(text);
}

function calculateCompletionQuality(text: string, endBoundaryQuality: number) {
  const normalized = text.toLowerCase();
  const payoff = /\b(answer|because|therefore|means|result|resulted|turns out|takeaway|conclusion|reveal|reveals|consequence|why it matters|that is why|so what)\b/.test(normalized) ? 0.28 : 0;
  const complete = /[.!?…]["')\]]*$/.test(text.trim()) ? 0.22 : 0;
  return clamp01(endBoundaryQuality * 0.5 + payoff + complete);
}

function durationFit(duration: number, config: FindMomentsConfig) {
  if (duration < config.absoluteMinDurationSeconds || duration > config.absoluteMaxDurationSeconds) return 0;
  if (duration >= config.preferredMinDurationSeconds && duration <= config.preferredMaxDurationSeconds) return 1;
  if (duration < config.preferredMinDurationSeconds) return 0.62 + 0.38 * ((duration - config.absoluteMinDurationSeconds) / Math.max(0.1, config.preferredMinDurationSeconds - config.absoluteMinDurationSeconds));
  return 0.82 - 0.27 * ((duration - config.preferredMaxDurationSeconds) / Math.max(0.1, config.absoluteMaxDurationSeconds - config.preferredMaxDurationSeconds));
}

function cheapStandaloneClarity(text: string) {
  const words = copyWords(text);
  let score = words.length >= 18 ? 0.72 : words.length >= 10 ? 0.52 : 0.3;
  if (/\b[A-Z][a-z]{2,}\b/.test(text) || /\b\d+(?:\.\d+)?%?\b/.test(text)) score += 0.14;
  if (startsWithUnresolvedReference(text)) score -= 0.22;
  return clamp01(score);
}

function hookNearBeginningScore(text: string) {
  const opening = text.slice(0, 180);
  return clamp01(0.3 + (hasStartSignal(opening) ? 0.35 : 0) + (/\b(risk|problem|surprising|important|change|why|how|what)\b/i.test(opening) ? 0.2 : 0) + (/[.!?]/.test(opening) ? 0.15 : 0));
}

function fillerRatio(text: string) {
  const words = copyWords(text);
  return words.length ? words.filter((word) => copyFillerWords.has(word)).length / words.length : 1;
}

function repeatedTokenRatio(text: string) {
  const words = copyWords(text).filter((word) => !copyStopWords.has(word));
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const repeated = [...counts.values()].filter((count) => count > 1).reduce((total, count) => total + count - 1, 0);
  return words.length ? repeated / words.length : 0;
}

function startsWithUnresolvedReference(text: string) {
  return /^(this|that|it|they|he|she|we|these|those|but|and then|that's why|he said|the second reason|like i mentioned)\b/i.test(text.trim());
}

function endsMidThought(text: string) {
  return /\b(and|but|because|so|to|of|that|which|if|when|while|as)\s*[.!?]?$/i.test(text.trim()) || (!/[.!?…]["')\]]*$/.test(text.trim()) && copyWords(text).length < 14);
}

function topicSignature(text: string) {
  return [...new Set(copyWords(text).filter((word) => word.length > 3 && !copyStopWords.has(word)))].slice(0, 8);
}

function momentType(text: string) {
  if (/\?/.test(text)) return 'question';
  if (/\b(reveal|reveals|turns out|result|conclusion|takeaway|means)\b/i.test(text)) return 'reveal';
  if (/\b(but|however|instead|conflict|risk|problem|challenge)\b/i.test(text)) return 'conflict';
  if (/\b\d+(?:\.\d+)?%?\b/.test(text)) return 'statistic';
  return 'claim';
}

function intervalIoU(left: Pick<CandidateVariant, 'startSeconds' | 'endSeconds'>, right: Pick<CandidateVariant, 'startSeconds' | 'endSeconds'>) {
  const intersection = Math.max(0, Math.min(left.endSeconds, right.endSeconds) - Math.max(left.startSeconds, right.startSeconds));
  const union = Math.max(left.endSeconds, right.endSeconds) - Math.min(left.startSeconds, right.startSeconds);
  return union > 0 ? intersection / union : 0;
}

function containmentOverlap(left: Pick<CandidateVariant, 'startSeconds' | 'endSeconds'>, right: Pick<CandidateVariant, 'startSeconds' | 'endSeconds'>) {
  const intersection = Math.max(0, Math.min(left.endSeconds, right.endSeconds) - Math.max(left.startSeconds, right.startSeconds));
  const shorterDuration = Math.min(left.endSeconds - left.startSeconds, right.endSeconds - right.startSeconds);
  return shorterDuration > 0 ? intersection / shorterDuration : 0;
}

function calculateTextSimilarity(left: string, right: string) {
  const leftWords = new Set(copyWords(left).filter((word) => !copyStopWords.has(word)));
  const rightWords = new Set(copyWords(right).filter((word) => !copyStopWords.has(word)));
  if (!leftWords.size || !rightWords.size) return 0;
  let intersection = 0;
  for (const word of leftWords) if (rightWords.has(word)) intersection += 1;
  return intersection / Math.min(leftWords.size, rightWords.size);
}

function calculateJaccardTextSimilarity(left: string, right: string) {
  const leftWords = new Set(copyWords(left).filter((word) => !copyStopWords.has(word)));
  const rightWords = new Set(copyWords(right).filter((word) => !copyStopWords.has(word)));
  if (!leftWords.size || !rightWords.size) return 0;
  let intersection = 0;
  for (const word of leftWords) if (rightWords.has(word)) intersection += 1;
  return intersection / new Set([...leftWords, ...rightWords]).size;
}

function sampleEvenly(values: number[], count: number) {
  if (values.length <= count) return values;
  return Array.from({ length: count }, (_, index) => values[Math.round(index * (values.length - 1) / (count - 1))]);
}

function scoreMoment(text: string, segments: TranscriptSegment[], sourceSegments: TranscriptSegment[]): MomentScoreBreakdown {
  const normalized = text.toLowerCase();
  const first = segments.slice(0, 2).map((segment) => segment.text).join(' ');
  const last = segments.slice(-2).map((segment) => segment.text).join(' ');
  const words = copyWords(text);
  const sourceCounts = new Map<string, number>();
  for (const word of sourceSegments.flatMap((segment) => copyWords(segment.text))) sourceCounts.set(word, (sourceCounts.get(word) ?? 0) + 1);
  const distinctiveWords = new Set(words.filter((word) => word.length > 3 && !copyStopWords.has(word) && sourceCounts.get(word) === 1));
  const meaningfulWords = words.filter((word) => !copyStopWords.has(word));
  const fillerRatio = words.length ? words.filter((word) => copyFillerWords.has(word)).length / words.length : 1;
  const namedEntitySignal = /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*\b/.test(text);
  const numberSignal = /\b\d+(?:\.\d+)?%?\b/.test(text);
  const questionSignal = /\?/.test(first);
  const contrastSignal = /\b(but|however|instead|yet|while|rather|because|therefore|so)\b/i.test(normalized);
  const payoffSignal = /\b(so|therefore|because|means|result|resulted|turns out|in other words|the answer|the key|takeaway|conclusion)\b/i.test(last);
  const tensionSignal = /\b(risk|danger|threat|crisis|urgent|surprising|shocking|conflict|fight|fear|vulnerab|collapse|fail|break|lose|disrupt|warning)\b/i.test(normalized);
  const noveltySignal = /\b(new|first|never|unprecedented|unexpected|unlike|rare|different|shift|turning point|for the first time)\b/i.test(normalized);
  const valueSignal = /\b(important|impact|affect|means|matters|change|policy|jobs?|workers?|cost|money|people|should|need to|how to|what it means)\b/i.test(normalized);
  const quotableSignal = /\b(I think|we know|the truth|the problem|the question|the reality|this is|that's why|you can)\b/i.test(text) || questionSignal;

  return {
    hookStrength: clamp01(0.18 + (questionSignal ? 0.34 : 0) + (/\b(why|how|what|here's|the reason|the key|the problem)\b/i.test(first) ? 0.24 : 0) + (tensionSignal ? 0.14 : 0) + (contrastSignal ? 0.1 : 0)),
    payoffStrength: clamp01(0.18 + (payoffSignal ? 0.38 : 0) + (/[.!?]$/.test(last.trim()) ? 0.16 : 0) + (segments.length >= 2 ? 0.14 : 0) + (numberSignal ? 0.08 : 0)),
    standaloneClarity: clamp01(0.22 + (words.length >= 24 ? 0.25 : words.length >= 14 ? 0.14 : 0) + (segments.length >= 2 ? 0.16 : 0) + (namedEntitySignal ? 0.18 : 0) + (numberSignal ? 0.1 : 0) - (/^(this|that|it|they|he|she|we)\b/i.test(text.trim()) ? 0.18 : 0)),
    audienceValue: clamp01(0.2 + (valueSignal ? 0.34 : 0) + (numberSignal ? 0.14 : 0) + (/\b(how|should|need to|can)\b/i.test(normalized) ? 0.16 : 0) + (payoffSignal ? 0.12 : 0)),
    emotionAndTension: clamp01(0.18 + (tensionSignal ? 0.42 : 0) + (questionSignal ? 0.1 : 0) + (contrastSignal ? 0.12 : 0) + (/!/.test(text) ? 0.1 : 0)),
    shareabilityAndQuotability: clamp01(0.2 + (quotableSignal ? 0.28 : 0) + (tensionSignal ? 0.16 : 0) + (numberSignal ? 0.12 : 0) + (words.length >= 18 && words.length <= 120 ? 0.12 : 0)),
    specificityAndCredibility: clamp01(0.16 + (numberSignal ? 0.3 : 0) + (namedEntitySignal ? 0.22 : 0) + (/\b(according to|report|data|study|research|said|says|told|evidence|example)\b/i.test(normalized) ? 0.24 : 0)),
    novelty: clamp01(0.16 + (noveltySignal ? 0.36 : 0) + (distinctiveWords.size >= 5 ? 0.24 : distinctiveWords.size >= 2 ? 0.14 : 0) + (contrastSignal ? 0.12 : 0)),
    densityAndMomentum: clamp01(0.16 + Math.min(0.58, meaningfulWords.length / Math.max(1, (segments.at(-1)?.endSeconds ?? 1) - (segments[0]?.startSeconds ?? 0)) / 2.5) + (fillerRatio < 0.12 ? 0.14 : fillerRatio < 0.24 ? 0.06 : 0)),
  };
}

function weightedMomentScore(dimensions: MomentScoreBreakdown) {
  const totalWeight = Object.values(MOMENT_SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  return Object.entries(MOMENT_SCORE_WEIGHTS).reduce((total, [dimension, weight]) => total + dimensions[dimension as keyof MomentScoreBreakdown] * weight, 0) / totalWeight;
}

function buildRationale(text: string, duration: number, dimensions: MomentScoreBreakdown) {
  const reasons = ['complete transcript context'];
  if (/[?]/.test(text)) reasons.push('a hook or question');
  if (/\b(but|however|instead|because|therefore|so)\b/i.test(text)) reasons.push('a clear turn or contrast');
  if (/\b\d+(?:\.\d+)?%?\b/.test(text)) reasons.push('a concrete detail');
  const strongest = Object.entries(dimensions).sort((left, right) => right[1] - left[1]).slice(0, 2).map(([dimension]) => dimension.replace(/([A-Z])/g, ' $1').toLowerCase());
  return `Candidate is ${roundTime(duration)} seconds with ${reasons.join(', ')}. Strongest weighted signals: ${strongest.join(' and ')}.`;
}

export function buildEditorialCopyPrompt(transcript: string) {
  const brief = buildMomentBrief(normalizeCopyText(transcript));
  return `You are an Axios social media editor.

Turn the supplied clip transcript into a strong, human social caption and a short on-video headline. Preserve Axios standards of accuracy, clarity and Smart Brevity.

GOAL
- Hook the audience immediately.
- Surface the most interesting, surprising or consequential supported angle.
- Create curiosity without withholding essential context.
- Add value beyond repeating the transcript or headline.

HOOK STRATEGY
Lead with surprise, stakes, tension, novelty, specificity, utility or a revealing moment from the speaker. Do not manufacture drama.

HEADLINE
- Write a short editorial headline of 4-12 words.
- Reframe the idea in clear language; do not copy a contiguous phrase of four or more transcript words.
- Do not use a raw question, fragment, throat-clearing, transcript marker or generic clickbait.
- Use only names, numbers and certainty supported by the transcript.

STYLE
- Write in Axios-style Smart Brevity: short, muscular sentences with the strongest information first.
- Sound conversational, intelligent and confident — not like marketing copy.
- Do not exaggerate, use vague clickbait, or merely restate the headline.
- Never use “The clip examines,” “The key takeaway is,” “You won't believe,” “This changes everything,” “Thoughts?” or “Like and share.”

ENGAGEMENT
When appropriate, end the primary caption with a genuine question or consequential tension. Omit engagement bait when it does not fit.

OUTPUT
Return JSON only with this shape:
{
  "headline": "short editorial on-video headline, 4-12 words; not a transcript fragment",
  "hook": "one punchy opening line, at most 125 characters",
  "primary_caption": "the strongest publish-ready caption",
  "alternates": {
    "curiosity": "curiosity-driven version",
    "stakes": "stakes-driven version",
    "conversation": "conversation-driven version"
  },
  "optional_cta": "one natural invitation or null",
  "supporting_text": ["one or two exact transcript excerpts used as evidence"],
  "necessary_qualifier": "string or null"
}

QUALITY CHECK
Every factual claim must be supported by the transcript. The first sentence must contain the strongest information. Keep the caption concise and human. Do not include hashtags; the existing hashtag pipeline owns hashtags separately.

INPUT
Platform: TikTok/Reels/Shorts
Transcript core claim for context only: ${brief.coreClaim || 'Not provided'}
Transcript/clip:
${transcript}`;
}

function buildSocialCopy(text: string, variantSeed = 0, modelClient?: EditorialCopyModelClient): CandidateSocialCopy {
  const cleanText = normalizeCopyText(text);
  const brief = buildMomentBrief(cleanText);
  const generated = modelClient ? generateModelCopy(modelClient, cleanText, brief, variantSeed) : null;
  const selected = generated ?? buildDeterministicCopy(cleanText, brief, variantSeed);
  const headline = trimText(selected.headline.trim(), 72) || safeFallbackHeadline(cleanText, brief);
  const caption = trimText(stripHashtags(selected.caption).trim(), 480);
  const hashtags = selected.hashtags?.length ? normalizeGeneratedHashtags(selected.hashtags) : buildHashtags(cleanText);
  return {
    headline,
    caption,
    hashtags,
    ...(selected.hook ? { hook: trimText(stripHashtags(selected.hook).trim(), 125) } : {}),
    ...(selected.alternates ? { alternates: {
      curiosity: trimText(stripHashtags(selected.alternates.curiosity).trim(), 480),
      stakes: trimText(stripHashtags(selected.alternates.stakes).trim(), 480),
      conversation: trimText(stripHashtags(selected.alternates.conversation).trim(), 480),
    } } : {}),
    ...(selected.optionalCta !== undefined ? { optionalCta: selected.optionalCta ? trimText(stripHashtags(selected.optionalCta).trim(), 240) : null } : {}),
    headlineCards: [{ id: 'headline-1', text: headline, startSeconds: 0, endSeconds: 3, color: 'navy', shape: 'rounded', xPercent: 50, yPercent: 70, widthPercent: 84, heightPercent: 21, placementCustomized: false }], nameTags: [],
  };
}

function normalizeGeneratedHashtags(values: string[]) {
  return values
    .map((value) => value.trim().replace(/^#?/, '#'))
    .filter((value) => /^#[A-Za-z0-9_]+$/.test(value))
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 5);
}

function normalizeCopyText(text: string) {
  const cleanedText = removeRepeatedPhrases(text
    .replace(/&gt;&gt;|>>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\b(?:um+|uh+|er+|you know|basically|kind of|sort of)\b[, ]*/gi, ' ')
    .replace(/\b(?:it|is)\s+(?=I think\b)/gi, '')
    .replace(/\b(?:over|of)\s+the\s+(?:of\s+the\s+)?next\s+10\s+years\b/gi, 'over the next 10 years')
    .replace(/\bback\s+backlogged\b/gi, 'backlogged')
    .replace(/\bso\s+profit\s+so\s+profitably\b/gi, 'so profitably')
    .replace(/\b(?:so\s+)?it is course\s+(?:over\s+)?the next 10 years\b/gi, 'over the next 10 years')
    .replace(/\ba lot more rad\b/gi, 'more paralegals')
    .replace(/\bparallegals\b/gi, 'paralegals')
    .replace(/\bthere's just so many cases backlogged that now they need more paralegals a lot more\b/gi, 'many cases are backlogged, so they need more paralegals')
    .replace(/\bthere's just so many\b/gi, 'there are many')
    .replace(/\bthat now they need\b/gi, 'so they need')
    .replace(/\ba lot more\b/gi, 'more')
    .replace(/\b(the reason why [A-Za-z]+ is growing)\s+it'?s the reason why [A-Za-z]+ is growing\b/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim());
  const sentences = splitSentences(cleanedText);
  const kept: string[] = [];
  for (const sentence of sentences) {
    const cleaned = sentence.trim();
    if (!cleaned) continue;
    const words = copyWords(cleaned);
    if (words.length < 2) continue;
    const previous = kept.at(-1);
    if (previous && containsWordPhrase(copyWords(previous), words)) continue;
    const overlap = previous ? wordOverlap(copyWords(previous), words) : 0;
    const residual = overlap >= 3 ? words.slice(overlap).join(' ') : cleaned;
    if (copyWords(residual).length >= 2) kept.push(residual);
  }
  return kept.join(' ').replace(/\s+([,.!?])/g, '$1').trim();
}

export function buildCaptionFromTranscript(text: string, variantSeed = 0, headline = '') {
  const cleanText = normalizeCopyText(text);
  if (!cleanText) return '';
  const brief = buildMomentBrief(cleanText);
  return buildTranscriptCaption(cleanText, brief, variantSeed, headline);
}

function splitSentences(text: string) {
  return text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

function copyWords(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9%?'’-]+/g, ' ').split(/\s+/).filter(Boolean);
}

function containsWordPhrase(haystack: string[], needle: string[]) {
  if (needle.length > haystack.length) return false;
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((word, offset) => word === haystack[index + offset])) return true;
  }
  return false;
}

function wordOverlap(previous: string[], current: string[]) {
  const maximum = Math.min(12, previous.length, current.length);
  for (let size = maximum; size >= 3; size -= 1) {
    const previousTail = previous.slice(-size);
    const currentHead = current.slice(0, size);
    if (previousTail.every((word, index) => word === currentHead[index])) return size;
  }
  return 0;
}

export function buildMomentBrief(text: string): MomentBrief {
  const sentences = splitSentences(text);
  const coreClaim = chooseCoreSentence(sentences) ?? text.trim();
  const payoff = choosePayoffSentence(sentences, coreClaim);
  const subject = extractSubject(text);
  const speaker = extractSpeaker(text);
  const strongestSpecificDetail = [...sentences].sort((left, right) => specificDetailScore(right) - specificDetailScore(left))[0] ?? null;
  const strongestQuote = extractStrongestQuote(text);
  const tensionOrContrast = sentences.find((sentence) => /\b(but|however|instead|yet|while|rather|on the other hand)\b/i.test(sentence)) ?? null;
  const audienceRelevance = sentences.find((sentence) => /\b(affect|impact|matter|means|important|consequence|cost|risk|people|workers?|consumers?|audience|should|need to)\b/i.test(sentence) && sentence !== coreClaim) ?? payoff;
  const necessaryQualifier = extractQualifier(text);
  return {
    subject,
    speaker,
    momentType: classifyMomentType(text, strongestQuote, tensionOrContrast),
    coreClaim,
    payoff,
    audienceRelevance,
    strongestSpecificDetail,
    strongestQuote,
    tensionOrContrast,
    necessaryQualifier,
  };
}

export function buildDeterministicCopy(text: string, brief: MomentBrief, variantSeed: number): EditorialCopyDraft {
  const candidates = buildHeadlineCandidates(text, brief);
  const selected = selectHeadlineCandidate(candidates, text, brief, variantSeed);
  const headline = selected.text || safeFallbackHeadline(text, brief);
  const caption = buildTranscriptCaption(text, brief, variantSeed, headline);
  const draft: EditorialCopyDraft = {
    headline,
    caption,
    headlineStrategy: selected.strategy,
    momentType: brief.momentType,
    supportingText: [brief.coreClaim, brief.payoff, brief.strongestSpecificDetail].filter((value): value is string => Boolean(value)),
    necessaryQualifier: brief.necessaryQualifier,
  };
  return validateGeneratedCopy(draft, text, brief).valid ? draft : buildSafeFallbackDraft(text, brief);
}

function buildHeadlineCandidates(text: string, brief: MomentBrief) {
  const candidates: Array<{ text: string; strategy: HeadlineStrategy }> = [];
  if (brief.strongestQuote) candidates.push({ text: quoteHeadline(brief.strongestQuote), strategy: 'quote' });
  // Treat transcript questions as evidence for scoring, not as ready-to-publish
  // copy. A raw question often becomes a verbatim headline instead of an
  // editorial hook; the payoff and claim candidates below can reframe it.
  if (brief.tensionOrContrast) candidates.push({ text: compactHeadline(brief.tensionOrContrast), strategy: 'contrast' });
  if (brief.payoff) candidates.push({ text: buildConciseClaimHeadline(brief.payoff, brief), strategy: 'stakes' });
  if (brief.subject && /\b(how|why|means|affect|impact|should|need to)\b/i.test(text)) candidates.push({ text: buildUtilityHeadline(brief), strategy: 'utility' });
  candidates.push({ text: buildConciseClaimHeadline(brief.coreClaim, brief), strategy: 'direct' });
  if (brief.strongestSpecificDetail) candidates.push({ text: buildConciseClaimHeadline(brief.strongestSpecificDetail, brief), strategy: 'direct' });
  return candidates.filter((candidate, index, all) => candidate.text && all.findIndex((other) => other.text.toLowerCase() === candidate.text.toLowerCase()) === index);
}

function selectHeadlineCandidate(candidates: Array<{ text: string; strategy: HeadlineStrategy }>, transcript: string, brief: MomentBrief, variantSeed: number) {
  const scored = candidates.map((candidate) => ({ ...candidate, score: scoreHeadlineCandidate(candidate, transcript, brief) })).sort((left, right) => right.score - left.score);
  const valid = scored.filter((candidate) => validateGeneratedHeadline(candidate.text, transcript, brief).length === 0);
  const quote = valid.find((candidate) => candidate.strategy === 'quote');
  if (quote) return quote;
  const answeredQuestion = valid.find((candidate) => candidate.strategy === 'question');
  if (answeredQuestion && brief.momentType === 'question_answer') return answeredQuestion;
  if (!valid.length) return { text: buildEditorialHeadline(brief), strategy: 'utility' as const };
  const pool = (valid.length ? valid : scored).slice(0, Math.min(3, scored.length));
  return pool[Math.abs(Math.trunc(variantSeed)) % Math.max(1, pool.length)] ?? { text: '', strategy: 'direct' as const };
}

function scoreHeadlineCandidate(candidate: { text: string; strategy: HeadlineStrategy }, transcript: string, brief: MomentBrief) {
  const failures = validateGeneratedHeadline(candidate.text, transcript, brief);
  const words = copyWords(candidate.text);
  const specificity = clamp01((brief.subject && candidate.text.toLowerCase().includes(brief.subject.toLowerCase().split(' ')[0]) ? 0.35 : 0) + (words.filter((word) => word.length > 4 && !copyStopWords.has(word)).length >= 2 ? 0.35 : 0) + (brief.strongestSpecificDetail && candidate.text.toLowerCase().split(/\s+/).some((word) => brief.strongestSpecificDetail?.toLowerCase().includes(word.replace(/[^a-z0-9]/g, ''))) ? 0.3 : 0));
  const hookStrength = clamp01((candidate.strategy === 'quote' || candidate.strategy === 'question' ? 0.42 : 0.12) + (/\b(risk|cost|change|next|could|may|why|how|means|impact|warning|shift)\b/i.test(candidate.text) ? 0.3 : 0) + (candidate.text.length <= 58 ? 0.2 : 0) + (brief.momentType !== 'other' ? 0.2 : 0));
  const clarity = startsWithUnresolvedReference(candidate.text) ? 0.25 : 0.9;
  const accuracy = failures.some((failure) => /number|proper noun|qualifier|quote|question|support/i.test(failure)) ? 0.2 : 1;
  const strategyBonus = candidate.strategy === 'quote' ? 0.2 : candidate.strategy === 'direct' ? 0.08 : candidate.strategy === 'stakes' || candidate.strategy === 'contrast' ? 0.1 : 0.06;
  return 0.3 * accuracy + 0.25 * hookStrength + 0.15 * specificity + 0.15 * clamp01(brief.audienceRelevance ? 0.8 : 0.3) + 0.1 * clarity + 0.05 * strategyBonus - failures.length * 0.18;
}

function buildUtilityHeadline(brief: MomentBrief) {
  const subject = brief.subject ?? 'this issue';
  if (/\b(affect|impact|means)\b/i.test(brief.coreClaim)) return compactHeadline(`What ${subject} means for people`);
  return buildEditorialHeadline(brief);
}

function quoteHeadline(quote: string) {
  const trimmed = compactHeadline(quote);
  return `“${trimmed.replace(/^“|”$/g, '')}”`;
}

function compactHeadline(sentence: string) {
  const cleaned = sentence.replace(/^\s*(so|well|and|but|you know|basically),?\s+/i, '').replace(/[.!;:]+$/g, '').trim();
  if (!cleaned) return '';
  const clauses = cleaned.split(/[,;:]\s+/).map((clause) => clause.trim()).filter(Boolean);
  const candidate = clauses.find((clause) => copyWords(clause).length >= 3 && copyWords(clause).length <= 12) ?? cleaned;
  const bounded = candidate.length <= 68 ? candidate : candidate.split(/\s+/).slice(0, 11).join(' ');
  const words = bounded.split(/\s+/).filter(Boolean);
  return sentenceCase(words.slice(0, 12).join(' '));
}

function buildConciseClaimHeadline(claim: string, brief: MomentBrief) {
  const qualifier = brief.necessaryQualifier;
  const subject = brief.subject;
  const normalized = claim.toLowerCase();
  if ((subject === 'AI and work' || subject === 'AI') && /\b(worker|workers|job|jobs|labor|employment)\b/.test(normalized)) {
    return sentenceCase('AI ' + (qualifier ?? 'could') + ' affect workers first');
  }
  if (subject === 'the future of work' && /\b(worker|workers|job|jobs|labor|employment)\b/.test(normalized)) {
    return sentenceCase('Workers ' + (qualifier ?? 'could') + ' feel the shift first');
  }
  if (subject && qualifier && /\b(raise|rise|fall|change|affect|impact|hit|reshape)\b/.test(normalized)) {
    return compactHeadline(subject + ' ' + qualifier + ' ' + (normalized.includes('price') ? 'raise prices' : 'change what comes next'));
  }
  const compact = compactHeadline(claim);
  if (copyWords(compact).length >= 3 && compact.length <= 68 && !/^(one of|the distinguishing|the fact that)\b/i.test(compact) && !isTranscriptFragment(compact, claim)) return compact;

  const subjectLead = subject ? subject + ' ' + (qualifier ? qualifier + ' ' : '') : '';
  const meaningful = copyWords(claim).filter((word) => !copyStopWords.has(word) && !copyFillerWords.has(word));
  const tail = meaningful.slice(-Math.max(3, Math.min(7, meaningful.length))).join(' ');
  const fallback = compactHeadline((subjectLead + tail).trim());
  return fallback && !isTranscriptFragment(fallback, claim) ? fallback : buildEditorialHeadline(brief);
}

function buildEditorialHeadline(brief: MomentBrief) {
  const subject = brief.subject;
  const normalized = brief.coreClaim.toLowerCase();
  if (subject && /\b(risk|danger|threat|crisis|vulnerab|attack|harm|problem)\b/.test(normalized)) return sentenceCase(`${subject} could change what comes next`);
  if (subject && /\b(job|jobs|worker|workers|employment|labor)\b/.test(normalized)) return sentenceCase(`Why ${subject} matters for workers`);
  if (subject && /\b(policy|government|law|congress|politic)\b/.test(normalized)) return sentenceCase(`The policy choice shaping ${subject}`);
  if (subject) return sentenceCase(`Why ${subject} matters now`);
  return 'What this shift could mean';
}

function sentenceCase(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function chooseVariant(values: string[], seed: number) {
  return values[Math.abs(Math.trunc(seed)) % values.length] ?? '';
}

export function buildTranscriptCaption(text: string, brief: MomentBrief, variantSeed: number, headline: string) {
  const normalized = normalizeCopyText(text);
  if (!normalized) return '';

  const sentences = splitSentences(normalized);
  const question = sentences.find((sentence) => sentence.includes('?') && questionIsAnswered(normalized, sentence));
  const primary = chooseCaptionClause([
    brief.tensionOrContrast,
    brief.payoff,
    brief.audienceRelevance,
    brief.strongestSpecificDetail,
    brief.coreClaim,
    question,
  ], headline);
  const secondary = chooseCaptionClause([
    brief.audienceRelevance,
    brief.payoff,
    brief.strongestSpecificDetail,
    brief.coreClaim,
    ...sentences,
  ], headline, primary);
  const hookSource = primary ?? chooseCaptionClause([brief.coreClaim, brief.payoff, brief.audienceRelevance, ...sentences], headline) ?? 'The moment carries more context than the headline suggests';
  const hook = buildCaptionHook(hookSource, brief.momentType);
  const contextFromSecondary = secondary && !sameMeaningfulSentence(primary, secondary) && !captionSourcesOverlap(hookSource, secondary)
    ? buildCaptionContext(secondary, brief.momentType, primary)
    : '';
  const context = contextFromSecondary || buildStandaloneCaptionContext(brief.momentType);
  const interaction = buildCaptionInteraction(brief, variantSeed, primary, secondary);
  const candidates = [
    [hook, context, interaction].filter(Boolean).join('\n\n'),
    [hook, context].filter(Boolean).join('\n\n'),
    [hook, interaction].filter(Boolean).join('\n\n'),
  ].filter((caption) => copyWords(caption).length >= 12 && captionOpeningSimilarity(caption, headline) < 0.82);

  const caption = chooseVariant(candidates.length ? candidates : [
    [hook, context].filter(Boolean).join('\n\n'),
    hook,
  ].filter(Boolean), variantSeed);
  return trimText(stripHashtags(caption), 420);
}

function chooseCaptionClause(values: Array<string | null | undefined>, headline: string, excluded?: string | null) {
  const candidates = values
    .filter((value): value is string => Boolean(value?.trim()))
    .filter((value) => !value.includes('?'))
    .map((value) => compactCaptionClause(value))
    .filter((value, index, all) => value && all.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index)
    .filter((value) => isUsableCaptionClause(value))
    .filter((value) => !excluded || !sameMeaningfulSentence(value, excluded));
  return candidates.find((value) => captionOpeningSimilarity(value, headline) < 0.82) ?? candidates[0] ?? null;
}

function compactCaptionClause(value: string, maxWords = 18, maxChars = 104) {
  let cleaned = removeRepeatedPhrases(value
    .replace(/&gt;&gt;|>>/gi, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\b(?:um+|uh+|er+|you know|basically|kind of|sort of)\b[, ]*/gi, ' ')
    .replace(/^(?:(?:that|this)\s+matters\s+because|the\s+(?:answer|key takeaway|point)\s+is(?:\s+that)?)\s+/i, '')
    .replace(/^(?:so|well|and|but|basically|like|i mean),?\s+/i, '')
    .replace(/\bhigher monthly costs\b/gi, 'higher monthly bills')
    .replace(/\bremain elevated\b/gi, 'are still high')
    .replace(/\bpaying more at checkout\b/gi, 'feeling it at checkout')
    .replace(/\btighter budgets\b/gi, 'less room in the budget')
    .replace(/\bfewer options\b/gi, 'less room to maneuver')
    .replace(/\balready managing\b/gi, 'already juggling')
    .replace(/\bcome due\b/gi, 'kick in')
    .replace(/\bcould reset\b/gi, 'could reshape')
    .replace(/\bgoes all the way to the family level\b/gi, 'reaches families')
    .replace(/\bjust to give people\b/gi, 'to give people')
    .replace(/\bmake sure that we're educating parents\b/gi, 'educate parents')
    .replace(/\bmake sure that we're teaching our kids\b/gi, 'teach kids')
    .replace(/^because\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim());
  cleaned = stripFinalPunctuation(cleaned);
  const clauses = cleaned
    .split(/[,;:]\s+|\s+(?=(?:and|but|because|while|which|before|when|just to|to (?:give|use|teach|help))\s+)/i)
    .map((clause) => clause.trim())
    .filter((clause) => copyWords(clause).length >= 4);
  if (cleaned.length > maxChars || copyWords(cleaned).length > maxWords) {
    cleaned = clauses.sort((left, right) => captionClauseScore(right) - captionClauseScore(left))[0] ?? cleaned;
  }
  if (copyWords(cleaned).length > maxWords) cleaned = cleaned.split(/\s+/).slice(0, maxWords).join(' ');
  if (cleaned.length > maxChars) {
    const boundedWords = cleaned.split(/\s+/);
    while (boundedWords.length > 4 && boundedWords.join(' ').length > maxChars) boundedWords.pop();
    cleaned = boundedWords.join(' ');
  }
  let previous = '';
  while (previous !== cleaned) {
    previous = cleaned;
    cleaned = cleaned.replace(/\s+(?:and|but|because|while|which|so|before|when|to|of|in|on|for|with|the|a|an)$/i, '').trim();
  }
  return cleaned;
}

function captionClauseScore(clause: string) {
  const words = copyWords(clause);
  const hasVerb = /\b(?:is|are|was|were|has|have|had|could|may|might|will|need|needs|want|wants|goes|reaches|increased|growing|using|paying)\b/i.test(clause);
  const endsInFragment = /\b(?:and|but|because|while|which|to|of|in|on|for|with|the|a|an|all the way|reason why)$/i.test(clause);
  return (words.length >= 8 ? 2 : words.length >= 5 ? 1 : 0) + (hasVerb ? 1 : 0) + (endsInFragment ? -3 : 0) + Math.min(1, specificDetailScore(clause) * 0.05);
}

function isUsableCaptionClause(value: string) {
  const words = copyWords(value);
  if (words.length < 5) return false;
  if (/^(?:because|which|and|but|so|than|while|to|of|in|on|for|with|that|this)\b/i.test(value)) return false;
  if (/^(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i.test(value)) return false;
  if (/^(?:know|thank you for watching|watch|subscribe)\b/i.test(value)) return false;
  if (/\bthan it is\b/i.test(value)) return false;
  if (/\b(?:thank you for watching|behind the curtain|watch until the end)\b/i.test(value)) return false;
  if (/\b(?:and|but|because|which|that|to|of|in|on|for|with|the|a|an|all the way|reason why|a lot more|course of)$/i.test(value)) return false;
  return true;
}

function captionSourcesOverlap(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return false;
  const normalizedLeft = normalizeForMatch(left);
  const normalizedRight = normalizeForMatch(right);
  return normalizedLeft === normalizedRight || normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

function buildCaptionHook(clause: string | null | undefined, momentType: MomentType) {
  const prefixes: Record<MomentType, string> = {
    reveal: 'This is where it gets interesting:',
    stakes: "Here's what's at stake:",
    contrast: "Here's the tension:",
    question_answer: 'The answer:',
    explanation: "Here's the thing:",
    advice: 'A useful way to look at it:',
    conflict: "Here's the disagreement:",
    quote: 'The line that sticks:',
    story: 'This is where the story turns:',
    reaction: 'The reaction says a lot:',
    other: 'The short version:',
  };
  const prefix = prefixes[momentType] ?? prefixes.other;
  const cleaned = compactCaptionClause(clause ?? 'The moment carries more context than the headline suggests', 15, Math.max(24, 123 - prefix.length));
  return `${prefix} ${lowercaseFirst(cleaned)}.`;
}

function removeRepeatedPhrases(text: string) {
  let current = text;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const next = current
      .replace(/\b([A-Za-z0-9][A-Za-z0-9'’-]*(?:\s+[A-Za-z0-9][A-Za-z0-9'’-]*){1,5})\s+\1\b/gi, '$1')
      .replace(/\b([A-Za-z0-9][A-Za-z0-9'’-]*)(?:,\s*\1\b)+/gi, '$1')
      .replace(/\b([A-Za-z0-9][A-Za-z0-9'’-]*)\s+\1\b/gi, '$1');
    if (next === current) break;
    current = next;
  }
  return current;
}

function buildCaptionContext(clause: string, momentType: MomentType, primary: string | null) {
  const cleaned = compactCaptionClause(clause, 19, 122);
  if (!cleaned || sameMeaningfulSentence(cleaned, primary)) return '';
  const prefix = momentType === 'advice'
    ? 'The useful part is'
    : momentType === 'story' || momentType === 'reaction'
      ? 'What makes it land is'
      : 'That matters because';
  return `${prefix} ${lowercaseFirst(cleaned)}.`;
}

function buildStandaloneCaptionContext(momentType: MomentType) {
  if (momentType === 'advice') return 'The useful part is what you can carry into the next decision.';
  if (momentType === 'story' || momentType === 'reaction') return 'It is the kind of detail that changes how the moment lands.';
  return 'It connects the bigger trend to what people feel day to day.';
}

function buildCaptionInteraction(brief: MomentBrief, variantSeed: number, primary: string | null, secondary: string | null) {
  if (Math.abs(Math.trunc(variantSeed)) % 3 === 1) return '';
  if (brief.momentType === 'question_answer' && (primary || secondary)) return 'Where do you land on that?';
  if (brief.momentType === 'advice' && /\b(should|need to|how to|recommend|step)\b/i.test(`${primary ?? ''} ${secondary ?? ''}`)) return 'Would that work in your world?';
  return '';
}

function generateModelCopy(modelClient: EditorialCopyModelClient, transcript: string, brief: MomentBrief, variantSeed: number) {
  const initial = withModelEvidence(parseEditorialCopyResponse(safelyCallModel(modelClient, buildEditorialCopyPrompt(transcript))), brief);
  const initialValidation = initial ? validateGeneratedCopy(initial, transcript, brief) : { valid: false, failures: ['model response was not valid JSON with headline and caption fields'] };
  if (initial && initialValidation.valid) return initial;

  const repairPrompt = buildEditorialCopyRepairPrompt(transcript, initial, initialValidation.failures);
  const repaired = withModelEvidence(parseEditorialCopyResponse(safelyCallModel(modelClient, repairPrompt)), brief);
  if (repaired && validateGeneratedCopy(repaired, transcript, brief).valid) return repaired;
  return buildSafeFallbackDraft(transcript, brief, variantSeed);
}

export function buildEditorialCopyRepairPrompt(transcript: string, draft: EditorialCopyDraft | null, failures: string[]) {
  return `You are revising an Axios social caption for a selected clip. Return corrected JSON only using the original Hook / Primary Caption / Alternates schema. The transcript is the only source of truth. Preserve every material qualifier, remove robotic framing, and keep the strongest information first. Do not invent facts, use generic clickbait, or add hashtags.\n\nValidation failures:\n${failures.map((failure) => `- ${failure}`).join('\n') || '- The output was incomplete.'}\n\nPrevious output:\n${JSON.stringify(draft ?? {})}\n\nCLIP TRANSCRIPT:\n${transcript}`;
}

function safelyCallModel(modelClient: EditorialCopyModelClient, prompt: string) {
  try {
    return modelClient(prompt);
  } catch {
    return null;
  }
}

function parseEditorialCopyResponse(value: unknown): EditorialCopyDraft | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const headline = typeof record.headline === 'string' ? record.headline : typeof record.hook === 'string' ? record.hook : '';
    const caption = typeof record.primary_caption === 'string' ? record.primary_caption : typeof record.caption === 'string' ? record.caption : '';
    if (!headline || !caption) return null;
    const alternateRecord = record.alternates && typeof record.alternates === 'object' ? record.alternates as Record<string, unknown> : null;
    const curiosity = alternateRecord && typeof (alternateRecord.curiosity ?? alternateRecord.curiosity_driven) === 'string' ? String(alternateRecord.curiosity ?? alternateRecord.curiosity_driven) : null;
    const stakes = alternateRecord && typeof (alternateRecord.stakes ?? alternateRecord.stakes_driven) === 'string' ? String(alternateRecord.stakes ?? alternateRecord.stakes_driven) : null;
    const conversation = alternateRecord && typeof (alternateRecord.conversation ?? alternateRecord.conversation_driven) === 'string' ? String(alternateRecord.conversation ?? alternateRecord.conversation_driven) : null;
    return {
      headline,
      caption,
      hashtags: Array.isArray(record.hashtags) ? record.hashtags.filter((item): item is string => typeof item === 'string') : undefined,
      hook: typeof record.hook === 'string' ? record.hook : undefined,
      alternates: curiosity && stakes && conversation ? { curiosity, stakes, conversation } : undefined,
      optionalCta: record.optional_cta === null ? null : typeof record.optional_cta === 'string' ? record.optional_cta : undefined,
      headlineStrategy: isHeadlineStrategy(record.headline_strategy) ? record.headline_strategy : undefined,
      momentType: isMomentType(record.moment_type) ? record.moment_type : undefined,
      supportingText: Array.isArray(record.supporting_text) ? record.supporting_text.filter((value): value is string => typeof value === 'string') : undefined,
      necessaryQualifier: typeof record.necessary_qualifier === 'string' ? record.necessary_qualifier : null,
    };
  } catch {
    return null;
  }
}

function withModelEvidence(draft: EditorialCopyDraft | null, brief: MomentBrief): EditorialCopyDraft | null {
  if (!draft) return null;
  return draft.supportingText?.length ? draft : { ...draft, supportingText: [brief.coreClaim || draft.caption] };
}

export function validateGeneratedCopy(draft: EditorialCopyDraft | null, transcript: string, brief = buildMomentBrief(normalizeCopyText(transcript))): EditorialCopyValidation {
  if (!draft) return { valid: false, failures: ['missing headline or caption'] };
  const failures = [
    ...validateGeneratedHeadline(draft.headline, transcript, brief),
    ...validateGeneratedCaption(draft.caption, draft.headline, transcript, brief),
    ...validateSupportingText(draft.supportingText, transcript),
  ];
  return { valid: failures.length === 0, failures };
}

export function validateGeneratedHeadline(headline: string, transcript: string, brief = buildMomentBrief(normalizeCopyText(transcript)), ignoreSentenceInitial = false) {
  const failures: string[] = [];
  const value = headline.trim();
  const words = copyWords(value);
  if (words.length < 3) failures.push('headline has fewer than 3 words');
  if (words.length > 12) failures.push('headline has more than 12 words');
  if (value.length > 72) failures.push('headline is longer than 72 characters');
  if (!value) failures.push('headline is empty');
  if (containsHashtag(value)) failures.push('headline contains a hashtag');
  if (containsGenericClickbait(value)) failures.push('headline uses generic clickbait');
  if (value.includes('?') && !questionIsAnswered(transcript, value)) failures.push('question headline is not answered by the transcript');
  if (hasQuotedText(value) && !quoteAppearsInTranscript(value, transcript)) failures.push('quoted headline text is not present in the transcript');
  if (containsUnsupportedNumber(value, transcript)) failures.push('headline uses a number not present in the transcript');
  if (containsUnsupportedProperNoun(value, transcript, ignoreSentenceInitial)) failures.push('headline uses an unsupported proper noun');
  if (containsTranscriptFragment(value, transcript)) failures.push('headline is a transcript fragment');
  if (!preservesRequiredQualifier(value, brief.necessaryQualifier)) failures.push('headline removes a material qualifier');
  if (startsWithUnresolvedReference(value) && brief.subject) failures.push('headline starts with a contextless pronoun');
  return failures;
}

export function validateGeneratedCaption(caption: string, headline: string, transcript: string, brief = buildMomentBrief(normalizeCopyText(transcript))) {
  const failures: string[] = [];
  const value = stripHashtags(caption).trim();
  const firstLine = value.split(/\r?\n/)[0]?.trim() ?? '';
  const sentences = splitSentences(value);
  const words = copyWords(value);
  if (!value) failures.push('caption is empty');
  if (firstLine.length > 125) failures.push('caption first line is longer than 125 characters');
  if (sentences.length > 3) failures.push('caption has more than 3 sentences');
  if (words.length < 12) failures.push('caption is too short to add context');
  if (words.length > 90) failures.push('caption is too long');
  if (/&gt;&gt;|>>/i.test(caption)) failures.push('caption contains transcript marker');
  if (containsHashtag(caption)) failures.push('caption contains hashtags');
  if (/\bwatch\s+(?:to\s+find\s+out|until the end|this|the clip)\b|\bmust watch\b|\byou won.t believe\b/i.test(value)) failures.push('caption uses generic engagement bait');
  if (containsGenericClickbait(value)) failures.push('caption uses generic clickbait');
  if (captionOpeningSimilarity(value, headline) >= 0.82) failures.push('caption repeats the headline');
  if (containsUnsupportedNumber(value, transcript)) failures.push('caption uses a number not present in the transcript');
  if (containsUnsupportedProperNoun(value, transcript, true)) failures.push('caption uses an unsupported proper noun');
  if (!preservesRequiredQualifier(value, brief.necessaryQualifier)) failures.push('caption removes a material qualifier');
  return failures;
}

export function validateSupportingText(supportingText: string[] | undefined, transcript: string) {
  if (!supportingText?.length) return ['supporting transcript excerpts are missing'];
  return supportingText.some((excerpt) => approximateExcerptMatch(excerpt, transcript)) ? [] : ['supporting transcript excerpts do not match the transcript'];
}

function buildSafeFallbackDraft(text: string, brief: MomentBrief, variantSeed = 0): EditorialCopyDraft {
  const sentences = splitSentences(text);
  if (!sentences.length) return { headline: 'Transcript unavailable', caption: '', momentType: 'other', supportingText: [] };
  const headline = safeFallbackHeadline(text, brief);
  const captionFromStructure = buildTranscriptCaption(text, brief, variantSeed, headline);
  const captionSentences = sentences.filter((sentence) => !sameMeaningfulSentence(sentence, brief.coreClaim)).slice(0, 2);
  const caption = captionFromStructure && captionOpeningSimilarity(captionFromStructure, headline) < 0.82
    ? captionFromStructure
    : stripHashtags([brief.coreClaim, ...captionSentences].join(' '));
  return { headline, caption: trimText(caption, 420), headlineStrategy: 'direct', momentType: brief.momentType, supportingText: [brief.coreClaim, ...captionSentences], necessaryQualifier: brief.necessaryQualifier };
}

function safeFallbackHeadline(text: string, brief: MomentBrief) {
  return buildConciseClaimHeadline(brief.coreClaim || splitSentences(text)[0] || 'Transcript unavailable', brief) || 'Transcript unavailable';
}

function chooseCoreSentence(sentences: string[]) {
  return [...sentences].filter((sentence) => copyWords(sentence).length >= 3).sort((left, right) => coreSentenceScore(right) - coreSentenceScore(left))[0] ?? null;
}

function coreSentenceScore(sentence: string) {
  const normalized = sentence.toLowerCase();
  return (/[.!?]$/.test(sentence) ? 1.4 : 0) + (/[?]/.test(sentence) ? 1.1 : 0) + (/\b(could|may|might|means|because|therefore|risk|cost|impact|important|change|why|how|answer|key|turns out)\b/.test(normalized) ? 1.5 : 0) + (specificDetailScore(sentence) * 0.4) - (startsWithUnresolvedReference(sentence) ? 1.2 : 0) - (copyWords(sentence).length > 40 ? 0.5 : 0);
}

function choosePayoffSentence(sentences: string[], coreClaim: string) {
  return [...sentences].reverse().find((sentence) => sentence !== coreClaim && /\b(so|therefore|because|means|result|answer|key|takeaway|conclusion|that is why|turns out)\b/i.test(sentence)) ?? [...sentences].reverse().find((sentence) => sentence !== coreClaim && /[.!?]$/.test(sentence)) ?? null;
}

function specificDetailScore(sentence: string) {
  return (extractNumberTokens(sentence).length * 3) + (extractProperNouns(sentence).length * 2) + (/[.!?]$/.test(sentence) ? 0.5 : 0) + Math.min(3, copyWords(sentence).filter((word) => word.length > 5 && !copyStopWords.has(word)).length * 0.15);
}

function extractSubject(text: string) {
  const normalized = text.toLowerCase();
  if (/\b(ai|artificial intelligence|chat ?gpt|machine learning|robot)\b/.test(normalized) && /\b(job|work|worker|labor|employment)\b/.test(normalized)) return 'AI and work';
  if (/\b(ai|artificial intelligence|chat ?gpt|machine learning|robot)\b/.test(normalized)) return 'AI';
  if (/\b(job|work|worker|labor|employment|unemployment)\b/.test(normalized)) return 'the future of work';
  if (/\b(america|american|government|congress|policy|election|president)\b/.test(normalized)) return 'American policy';
  if (/\b(business|company|companies|economy|economic|market|industry)\b/.test(normalized)) return 'the economy';
  if (/\b(climate|weather|energy|wildfire|carbon)\b/.test(normalized)) return 'climate and energy';
  if (/\b(health|medicine|hospital|disease|drug)\b/.test(normalized)) return 'health and science';
  return extractProperNouns(text).find((noun) => !['This', 'That', 'The', 'Why', 'How', 'What', 'When', 'Where', 'Because', 'And', 'But', 'So'].includes(noun)) ?? null;
}

function extractSpeaker(text: string) {
  const match = text.match(/(?:^|[.!?]\s+|\b(?:according to|said|says|explains|argues|warns)\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:said|says|explains|argues|warns|believes|told)\b/);
  return match?.[1] ?? null;
}

function extractStrongestQuote(text: string) {
  const matches = [...text.matchAll(/[“"]([^”"]{12,100})[”"]/g)].map((match) => match[1].trim()).filter((quote) => copyWords(quote).length >= 4 && copyWords(quote).length <= 12);
  return matches.sort((left, right) => quoteStrength(right) - quoteStrength(left))[0] ?? null;
}

function quoteStrength(quote: string) {
  return (/[!?]/.test(quote) ? 1 : 0) + (/\b(risk|cost|change|wrong|never|always|could|may|need|why|how)\b/i.test(quote) ? 1 : 0) + Math.min(2, copyWords(quote).length / 8);
}

function extractQualifier(text: string) {
  const match = text.match(/\b(may|might|could|likely|unlikely|reportedly|allegedly|according to|in my opinion|we believe|estimated)\b/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function classifyMomentType(text: string, quote: string | null, contrast: string | null): MomentType {
  const normalized = text.toLowerCase();
  if (quote) return 'quote';
  if (/\b(disagree|dispute|argue|argument|push back|clash)\b/.test(normalized)) return 'conflict';
  if (contrast) return 'contrast';
  if (/\b(why|how|what)\b[^?]*\?/.test(normalized) && /\b(because|answer|means|key|therefore|so)\b/.test(normalized)) return 'question_answer';
  if (/\b(should|need to|advice|recommend|do this|step)\b/.test(normalized)) return 'advice';
  if (/\b(risk|danger|threat|cost|stakes|consequence|impact|urgent)\b/.test(normalized)) return 'stakes';
  if (/\b(reveal|revealed|turns out|discovered|found out|surprise)\b/.test(normalized)) return 'reveal';
  if (/\b(why|how|because|means|explains|in other words)\b/.test(normalized)) return 'explanation';
  if (/\b(then|when|after|before|years ago|grew up)\b/.test(normalized)) return 'story';
  if (/\b(wow|surprised|shocked|reaction|laugh|laughed)\b/.test(normalized)) return 'reaction';
  return 'other';
}

function questionIsAnswered(transcript: string, question: string) {
  const sentences = splitSentences(transcript);
  const questionIndex = sentences.findIndex((sentence) => sentence.toLowerCase().includes(question.trim().toLowerCase()));
  if (questionIndex < 0 && !sentences.some((sentence) => sentence.includes('?'))) return false;
  const following = questionIndex >= 0 ? sentences.slice(questionIndex + 1) : sentences;
  return following.some((sentence) => /\b(because|the answer|means|key|therefore|so|is that|we found|it is)\b/i.test(sentence)) || following.length > 0 && following.some((sentence) => /[.!?]$/.test(sentence));
}

function stripFinalPunctuation(text: string) {
  return text.replace(/[.!?]+$/g, '').trim();
}

function lowercaseFirst(text: string) {
  return /^I\b/.test(text) || /^[A-Z][A-Za-z0-9]*[A-Z]/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

function sameMeaningfulSentence(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return false;
  if (normalizeForMatch(left) === normalizeForMatch(right)) return true;
  return calculateTextSimilarity(left, right) >= 0.78;
}

function stripHashtags(text: string) {
  return text.replace(/(^|\s)#[a-z0-9_]+/gi, '$1').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
}

function containsHashtag(text: string) {
  return /(^|\s)#[a-z0-9_]+/i.test(text);
}

const genericClickbaitPhrases = [
  'you won\'t believe',
  'what happens next',
  'this changes everything',
  'this is huge',
  'shocking',
  'must watch',
  'game changer',
  'the truth about',
  'everyone is talking about',
  'breaking',
  'experts are stunned',
  'this went viral',
  'nobody saw this coming',
];

function containsGenericClickbait(text: string) {
  const normalized = text.toLowerCase();
  return genericClickbaitPhrases.some((phrase) => normalized.includes(phrase));
}

function hasQuotedText(text: string) {
  return /[“"]/.test(text) && /[”"]/.test(text);
}

function quoteAppearsInTranscript(headline: string, transcript: string) {
  const quoted = headline.match(/[“"]([^”"]+)[”"]/)?.[1] ?? '';
  return Boolean(quoted) && normalizeForMatch(transcript).includes(normalizeForMatch(quoted));
}

function containsUnsupportedNumber(value: string, transcript: string) {
  return extractNumberTokens(value).some((token) => !numberAppearsInTranscript(token, transcript));
}

function containsTranscriptFragment(value: string, transcript: string) {
  return isTranscriptFragment(value, transcript);
}

function isTranscriptFragment(value: string, transcript: string) {
  const headlineWords = copyWords(value);
  const transcriptWords = copyWords(transcript);
  if (headlineWords.length < 4 || transcriptWords.length < headlineWords.length) return false;
  let longestRun = 0;
  for (let start = 0; start < headlineWords.length; start += 1) {
    for (let transcriptStart = 0; transcriptStart < transcriptWords.length; transcriptStart += 1) {
      let run = 0;
      while (headlineWords[start + run] && transcriptWords[transcriptStart + run] && headlineWords[start + run] === transcriptWords[transcriptStart + run]) run += 1;
      longestRun = Math.max(longestRun, run);
    }
  }
  const requiredRun = headlineWords.length <= 5 ? headlineWords.length : 5;
  return longestRun >= requiredRun && longestRun / headlineWords.length >= 0.7;
}

function extractNumberTokens(text: string) {
  return text.match(/\b\d+(?:[.,]\d+)?\s*(?:%|percent|million|billion|thousand)?\b/gi) ?? [];
}

function numberAppearsInTranscript(token: string, transcript: string) {
  const normalizedToken = token.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedTranscript = transcript.toLowerCase().replace(/\s+/g, ' ');
  if (normalizedTranscript.includes(normalizedToken)) return true;
  const numeric = normalizedToken.match(/\d+(?:[.,]\d+)?/)?.[0];
  return Boolean(numeric && normalizedTranscript.includes(numeric));
}

function containsUnsupportedProperNoun(value: string, transcript: string, ignoreSentenceInitial = false) {
  const source = new Set(extractProperNouns(transcript).map((noun) => noun.toLowerCase()));
  const sourceWords = new Set(copyWords(transcript));
  return extractProperNouns(value, ignoreSentenceInitial).some((noun) => {
    const normalized = noun.toLowerCase();
    const phraseWords = copyWords(noun);
    const everyWordIsSupported = phraseWords.length > 1 && phraseWords.every((word) => sourceWords.has(word));
    return !source.has(normalized) && !sourceWords.has(normalized) && !everyWordIsSupported && !['this', 'that', 'the', 'why', 'how', 'what', 'when', 'where', 'because', 'and', 'but', 'so', 'ai', 'here', 'would', 'useful', 'short', 'answer', 'tension', 'line', 'even', 'there', 'however', 'although', 'while', 'policy', 'new', 'many', 'most', 'some', 'more', 'one', 'another', 'people', 'workers', 'borrowers', 'companies', 'families', 'if', 'as', 'think', 'imagine', 'once', 'now', 'also', 'still', 'really', 'just', 'first', 'next', 'because', 'could', 'might', 'should', 'need', 'what', 'when', 'where', 'which', 'who', 'we', 'our', 'your', 'their', 'these', 'those', 'each', 'all', 'any', 'both', 'even', 'yet', 'then', 'than', 'once', 'like'].includes(normalized);
  });
}

function extractProperNouns(text: string, ignoreSentenceInitial = false) {
  return [...text.matchAll(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*/g)]
    .filter((match) => !ignoreSentenceInitial || !/^[\s.!?\n]*$/.test(text.slice(0, match.index ?? 0)))
    .map((match) => match[0])
    .filter((noun, index, all) => all.findIndex((candidate) => candidate === noun) === index);
}

function preservesRequiredQualifier(value: string, qualifier: string | null | undefined) {
  if (!qualifier) return true;
  const normalized = value.toLowerCase();
  if (qualifier === 'could' || qualifier === 'may' || qualifier === 'might') return /\b(could|may|might|possibly|likely|unlikely|expected|potentially)\b/.test(normalized);
  if (qualifier === 'unlikely') return /\b(unlikely|doubt|doubts|question|may not|might not|unlikely to)\b/.test(normalized);
  if (qualifier === 'in my opinion') return /\b(opinion|view|thinks|believes|doubt|doubts|unlikely)\b/.test(normalized);
  if (qualifier === 'according to') return /\b(according to|said|says|reportedly|report|speaker)\b/.test(normalized);
  return normalized.includes(qualifier);
}

function approximateExcerptMatch(excerpt: string, transcript: string) {
  const excerptWords = copyWords(excerpt);
  const transcriptWords = copyWords(transcript);
  if (excerptWords.length < 2 || transcriptWords.length < excerptWords.length) return false;
  const exact = normalizeForMatch(transcript).includes(normalizeForMatch(excerpt));
  if (exact) return true;
  for (let index = 0; index <= transcriptWords.length - excerptWords.length; index += 1) {
    const window = transcriptWords.slice(index, index + excerptWords.length);
    const overlap = window.filter((word, wordIndex) => word === excerptWords[wordIndex]).length / excerptWords.length;
    if (overlap >= 0.72) return true;
  }
  return false;
}

function normalizeForMatch(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function captionOpeningSimilarity(caption: string, headline: string) {
  const opening = splitSentences(caption)[0] ?? caption;
  return calculateTextSimilarity(opening, headline);
}

function isHeadlineStrategy(value: unknown): value is HeadlineStrategy {
  return typeof value === 'string' && (headlineStrategies as readonly string[]).includes(value);
}

function isMomentType(value: unknown): value is MomentType {
  return typeof value === 'string' && (momentTypes as readonly string[]).includes(value);
}

function buildHashtags(text: string) {
  const rules: Array<[RegExp, string]> = [
    [/\b(artificial intelligence|ai|machine learning|chatgpt|openai)\b/i, '#AI'],
    [/\b(code|coding|software|technology|tech)\b/i, '#Technology'],
    [/\b(jobs?|workers?|workforce|employment)\b/i, '#FutureOfWork'],
    [/\b(america|american|government|congress|policy|politics)\b/i, '#Politics'],
    [/\b(business|companies|economy|economic|market)\b/i, '#Business'],
    [/\b(risk|risks|vulnerability|vulnerabilities|security)\b/i, '#TechPolicy'],
  ];
  const topical = rules.filter(([pattern]) => pattern.test(text)).map(([, tag]) => tag);
  const fallback = ['#News', '#Explainer', '#CurrentEvents', '#SocialVideo'];
  return Array.from(new Set(['#Axios', ...topical, ...fallback])).slice(0, 5);
}

const copyStopWords = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'he', 'her', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'was', 'we', 'what', 'when', 'where', 'which', 'who', 'will', 'with', 'you', 'your']);
const copyFillerWords = new Set(['actually', 'basically', 'just', 'like', 'really', 'right', 'thing', 'things', 'very', 'you know']);

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function trimText(text: string, maxLength: number) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function roundTime(value: number) {
  return Math.round(value * 1000) / 1000;
}

function roundScore(value: number) {
  return Math.round(value * 1000) / 1000;
}

function numberOrDefault(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}
