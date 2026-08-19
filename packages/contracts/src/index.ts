import { z } from 'zod';

export const sourceTypes = ['upload', 'direct_url', 'platform_url'] as const;
export const mediaTypes = ['video', 'audio'] as const;
export const jobModes = ['whole_media', 'find_moments', 'transcribe_only'] as const;
export const jobStates = ['queued', 'processing', 'completed', 'failed', 'cancelled'] as const;
export const reviewStatuses = ['proposed', 'accepted', 'rejected', 'edited'] as const;
export const renderProfiles = ['vertical_reel', 'square', 'landscape'] as const;
export const renderFitModes = ['cover', 'contain'] as const;
export const renderBackgrounds = ['black', 'white', 'dark_blue', 'blurred'] as const;
export const logoPositions = ['top-left', 'top-center', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right'] as const;
export const captionModes = ['none', 'sidecar', 'burned'] as const;
export const youtubeIngestionStatuses = ['discovered', 'archive_available', 'queued', 'downloading', 'asset_registered', 'processing', 'ready', 'failed'] as const;
export const headlineCardColors = ['navy', 'black', 'purple', 'blue', 'green', 'red', 'white'] as const;
export const headlineCardShapes = ['rounded', 'pill'] as const;
export const CreateSourceSchema = z.object({ sourceType: z.enum(sourceTypes), mediaType: z.enum(mediaTypes), uri: z.string().url(), provider: z.string().min(1).optional(), metadata: z.record(z.unknown()).default({}) }).superRefine((value, ctx) => { if (value.sourceType === 'platform_url' && !value.provider) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provider is required for platform_url', path: ['provider'] }); });
export const CreateJobSchema = z.object({ sourceId: z.string().uuid(), mode: z.enum(jobModes), idempotencyKey: z.string().min(1).max(255) });
export const JobSchema = z.object({ id: z.string().uuid(), sourceId: z.string().uuid(), mode: z.enum(jobModes), status: z.enum(jobStates), attempts: z.number().int().nonnegative(), progress: z.number().int().min(0).max(100), result: z.record(z.unknown()).nullable(), claimedAt: z.string().datetime().nullable(), leaseExpiresAt: z.string().datetime().nullable(), lastError: z.string().nullable(), completedAt: z.string().datetime().nullable(), createdAt: z.string().datetime() });
export const ProbeSchema = z.object({ sourceId: z.string().uuid(), status: z.enum(['processing', 'completed', 'failed']), contentType: z.string().nullable(), byteSize: z.number().int().nonnegative().nullable(), durationSeconds: z.number().nonnegative().nullable(), width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable(), videoCodec: z.string().nullable(), audioCodec: z.string().nullable(), frameRate: z.number().nonnegative().nullable(), probe: z.record(z.unknown()).nullable(), error: z.string().nullable(), updatedAt: z.string().datetime() });
export const TranscriptSegmentSchema = z.object({ startSeconds: z.number().nonnegative(), endSeconds: z.number().nonnegative(), text: z.string().min(1) }).refine((value) => value.endSeconds >= value.startSeconds, { message: 'endSeconds must be greater than or equal to startSeconds' });
export const TranscriptSchema = z.object({ id: z.string().uuid(), jobId: z.string().uuid(), status: z.enum(['processing', 'completed', 'failed']), provider: z.string().nullable(), language: z.string().nullable(), fullText: z.string().nullable(), durationSeconds: z.number().nonnegative().nullable(), segments: z.array(TranscriptSegmentSchema), error: z.string().nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export const HeadlineCardSchema = z.object({ id: z.string().min(1).max(80), text: z.string().max(180), startSeconds: z.number().min(0).max(60), endSeconds: z.number().min(0).max(60), color: z.enum(headlineCardColors), shape: z.enum(headlineCardShapes).default('rounded'), xPercent: z.number().min(0).max(100).default(50), yPercent: z.number().min(0).max(100).default(70), widthPercent: z.number().min(12).max(92).default(84), heightPercent: z.number().min(8).max(70).default(21), transitionSeconds: z.number().min(0.05).max(2).default(0.35), placementCustomized: z.boolean().default(false) }).refine((value) => value.endSeconds > value.startSeconds, { message: 'headline card endSeconds must be greater than startSeconds', path: ['endSeconds'] });
export const NameTagSchema = z.object({ id: z.string().min(1).max(80), name: z.string().max(80), title: z.string().max(100), startSeconds: z.number().min(0).max(60), endSeconds: z.number().min(0).max(60), color: z.enum(headlineCardColors).default('white'), xPercent: z.number().min(0).max(100).default(32), yPercent: z.number().min(0).max(100).default(78), widthPercent: z.number().min(18).max(70).default(58), heightPercent: z.number().min(8).max(42).default(14), transitionSeconds: z.number().min(0.05).max(2).default(0.35), placementCustomized: z.boolean().default(false) }).refine((value) => value.endSeconds > value.startSeconds, { message: 'nametag endSeconds must be greater than startSeconds', path: ['endSeconds'] });
const RenderSpecObjectSchema = z.object({}).passthrough();
export const RenderSpecSchema = z.object({
  schema: z.literal('axios.clip.render-spec.v1'),
  rendererTarget: z.literal('headless_chromium'),
  dimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive().refine((value) => value === 30, { message: 'renderSpec dimensions.fps must be 30' }) }).passthrough(),
  source: RenderSpecObjectSchema,
  video: RenderSpecObjectSchema,
  logo: RenderSpecObjectSchema,
  headlineCards: z.array(RenderSpecObjectSchema),
  nameTags: z.array(RenderSpecObjectSchema),
  captions: z.union([RenderSpecObjectSchema, z.array(RenderSpecObjectSchema)]),
}).passthrough();
export const CandidateSocialCopySchema = z.object({
  headline: z.string(),
  caption: z.string(),
  hashtags: z.array(z.string()),
  hook: z.string().max(125).optional(),
  alternates: z.object({ curiosity: z.string().max(480), stakes: z.string().max(480), conversation: z.string().max(480) }).optional(),
  optionalCta: z.string().max(240).nullable().optional(),
  headlineCards: z.array(HeadlineCardSchema).default([]),
  nameTags: z.array(NameTagSchema).default([]),
  // The clip editor owns these opaque-but-versioned JSON values. Keeping them
  // in the contract prevents the API's Zod parsing from silently stripping
  // editor state before it reaches the worker.
  transcriptEdits: z.unknown().optional(),
  subtitlePosition: z.unknown().optional(),
});
export const CandidateEvidenceSchema = z.object({ startSeconds: z.number().nonnegative(), endSeconds: z.number().nonnegative(), text: z.string().min(1) });
export const AudienceConfidenceLabelSchema = z.enum(['low', 'medium', 'high']);
export const AudienceClassificationSchema = z.enum(['hot', 'hidden_gem', 'emerging', 'breakout', 'rewatch_magnet', 'strong_entry', 'sticky', 'proven', 'watch', 'cooling', 'possible_confusion']);
export const AudienceTrendSchema = z.object({ scoreDelta: z.number().nullable(), scoreDeltaPercent: z.number().nullable(), previousScore: z.number().nullable(), previousCollectedAt: z.string().datetime().nullable(), daysTracked: z.number().int().nonnegative(), consecutiveStrongUpdates: z.number().int().nonnegative() });
export const AudienceSignalSchema = z.object({
  primaryClassification: AudienceClassificationSchema.nullable().optional(),
  audienceSignal: z.number().min(0).max(100),
  rewatchScore: z.number().min(0).max(100),
  retentionScore: z.number().min(0).max(100),
  entryScore: z.number().min(0).max(100),
  exitSafetyScore: z.number().min(0).max(100),
  confidence: z.number().min(0).max(100),
  confidenceLabel: AudienceConfidenceLabelSchema,
  totalSegmentImpressions: z.number().int().nonnegative(),
  intervalCount: z.number().int().positive(),
  raw: z.object({
    startAudienceWatchRatio: z.number().nullable().optional(),
    endAudienceWatchRatio: z.number().nullable().optional(),
    startStartedWatching: z.number().nullable().optional(),
    peakAudienceWatchRatio: z.number().nullable(),
    medianAudienceWatchRatio: z.number().nullable(),
    peakLocalRewatchLift: z.number().nullable(),
    medianLocalRewatchLift: z.number().nullable(),
    localBaseline: z.number().nullable(),
    peakRelativeRetentionPerformance: z.number().nullable(),
    medianRelativeRetentionPerformance: z.number().nullable(),
    startIntervalEntryScore: z.number().nullable(),
    endIntervalStopRate: z.number().nullable(),
    normalStopRate: z.number().nullable(),
    endingIntervalCount: z.number().int().nonnegative(),
    followingIntervalCount: z.number().int().nonnegative(),
  }),
  trend: AudienceTrendSchema.nullable().optional(),
  classifications: z.array(AudienceClassificationSchema).optional(),
});
export const AudienceMomentSchema = AudienceSignalSchema.extend({ id: z.string(), videoId: z.string().uuid(), startSeconds: z.number().nonnegative(), endSeconds: z.number().nonnegative(), overlappingClipIds: z.array(z.string().uuid()), overlapPercentage: z.number().min(0).max(1), coveredByExistingClip: z.boolean() }).refine((value) => value.endSeconds >= value.startSeconds, { message: 'audience moment end must be greater than or equal to start' });
export const CandidateSchema = z.object({ id: z.string().uuid(), jobId: z.string().uuid(), transcriptId: z.string().uuid().nullable(), startSeconds: z.number().nonnegative(), endSeconds: z.number().nonnegative(), score: z.number().nullable(), confidence: z.number().min(0).max(1).nullable(), reviewStatus: z.enum(reviewStatuses), rationale: z.string().nullable(), evidence: z.array(CandidateEvidenceSchema), socialCopy: CandidateSocialCopySchema, audienceSignal: AudienceSignalSchema.nullable().default(null), metadata: z.record(z.unknown()).default({}), editedStartSeconds: z.number().nonnegative().nullable(), editedEndSeconds: z.number().nonnegative().nullable(), reviewedBy: z.string().nullable(), reviewedAt: z.string().datetime().nullable(), notes: z.string().nullable(), posted: z.boolean(), postedBy: z.string().nullable(), postedAt: z.string().datetime().nullable(), createdAt: z.string().datetime() }).refine((value) => value.endSeconds >= value.startSeconds, { message: 'endSeconds must be greater than or equal to startSeconds' });
export const UpdateCandidateSchema = z.object({ startSeconds: z.number().nonnegative().optional(), endSeconds: z.number().nonnegative().optional(), reviewStatus: z.enum(reviewStatuses).optional(), reviewer: z.string().min(1).max(255).nullable().optional(), notes: z.string().max(5000).nullable().optional(), posted: z.boolean().optional(), postedBy: z.string().min(1).max(255).nullable().optional(), socialCopy: CandidateSocialCopySchema.optional() }).superRefine((value, ctx) => { if (value.startSeconds !== undefined && value.endSeconds !== undefined && value.endSeconds < value.startSeconds) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'endSeconds must be greater than or equal to startSeconds', path: ['endSeconds'] }); });
export const BrandAssetSchema = z.object({ id: z.string().uuid(), name: z.string(), show: z.string(), assetId: z.string().uuid(), assetUrl: z.string(), contentType: z.string().nullable(), active: z.boolean(), createdAt: z.string().datetime() });
export const YouTubeVideoSchema = z.object({
  id: z.string().uuid(),
  youtubeVideoId: z.string().min(1),
  canonicalUrl: z.string().url(),
  title: z.string(),
  description: z.string().nullable(),
  channel: z.object({ id: z.string().uuid(), youtubeChannelId: z.string(), handle: z.string().nullable(), name: z.string().nullable() }).nullable(),
  mediaSourceId: z.string().uuid().nullable(),
  publishedAt: z.string().datetime().nullable(),
  uploadDate: z.string().nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  availability: z.string().nullable(),
  liveStatus: z.string().nullable(),
  thumbnailUrl: z.string().url().nullable(),
  viewCount: z.number().int().nonnegative().nullable(),
  likeCount: z.number().int().nonnegative().nullable(),
  commentCount: z.number().int().nonnegative().nullable(),
  archivePath: z.string().nullable(),
  archiveFilename: z.string().nullable(),
  archiveByteSize: z.number().int().nonnegative().nullable(),
  ingestionStatus: z.enum(youtubeIngestionStatuses),
  ingestionJobId: z.string().uuid().nullable(),
  ingestionRequestedAt: z.string().datetime().nullable(),
  ingestionError: z.string().nullable(),
  candidateCount: z.number().int().nonnegative(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  lastMetadataSyncAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const YouTubeChannelSchema = z.object({
  id: z.string().uuid(),
  youtubeChannelId: z.string(),
  handle: z.string().nullable(),
  name: z.string().nullable(),
  uploadsPlaylistId: z.string().nullable(),
  active: z.boolean(),
  syncStatus: z.enum(['idle', 'running', 'completed', 'failed']),
  lastSyncedAt: z.string().datetime().nullable(),
  lastSyncedPublishedAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  videoCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const YouTubeSyncRequestSchema = z.object({
  fullScan: z.boolean().default(false),
  maxPages: z.number().int().min(1).max(1000).optional(),
});
export const YouTubeIngestRequestSchema = z.object({
  channelId: z.string().min(1).optional(),
  videoIds: z.array(z.string().min(1)).max(100).optional(),
  limit: z.number().int().min(1).max(100).default(5),
  mode: z.enum(['whole_media', 'find_moments', 'transcribe_only']).default('find_moments'),
  dryRun: z.boolean().default(false),
});
export const CreateRenderSchema = z.object({ profile: z.enum(renderProfiles).default('vertical_reel'), fitMode: z.enum(renderFitModes).default('cover'), background: z.enum(renderBackgrounds).default('dark_blue'), logoPosition: z.enum(logoPositions).default('top-left'), logoAssetId: z.string().uuid().nullable().default(null), captionMode: z.enum(captionModes).default('burned'), includeLogo: z.boolean().default(true), renderSpec: RenderSpecSchema.optional() });
export const RenderSchema = z.object({ id: z.string().uuid(), candidateId: z.string().uuid(), profile: z.enum(renderProfiles), fitMode: z.enum(renderFitModes), background: z.enum(renderBackgrounds).default('dark_blue'), logoPosition: z.enum(logoPositions), logoAssetId: z.string().uuid().nullable(), captionMode: z.enum(captionModes), includeLogo: z.boolean(), renderSpec: RenderSpecSchema.nullable().default(null), status: z.enum(jobStates), progress: z.number().int().min(0).max(100), attempts: z.number().int().nonnegative(), error: z.string().nullable(), assetId: z.string().uuid().nullable(), captionAssetId: z.string().uuid().nullable(), thumbnailAssetId: z.string().uuid().nullable(), manifestAssetId: z.string().uuid().nullable(), renderManifest: z.record(z.unknown()).nullable(), playbackUrl: z.string().nullable(), captionsUrl: z.string().nullable(), thumbnailUrl: z.string().nullable(), manifestUrl: z.string().nullable(), createdAt: z.string().datetime(), completedAt: z.string().datetime().nullable() });
export type CreateSource = z.infer<typeof CreateSourceSchema>; export type CreateJob = z.infer<typeof CreateJobSchema>; export type Job = z.infer<typeof JobSchema>; export type Probe = z.infer<typeof ProbeSchema>; export type Transcript = z.infer<typeof TranscriptSchema>; export type Candidate = z.infer<typeof CandidateSchema>; export type BrandAsset = z.infer<typeof BrandAssetSchema>; export type RenderSpec = z.infer<typeof RenderSpecSchema>; export type Render = z.infer<typeof RenderSchema>;
export const thumbnailSegmentationProviders = ['sam3', 'u2netp'] as const;
export const thumbnailProjectStates = ['queued', 'processing', 'ready', 'export_queued', 'exporting', 'completed', 'failed'] as const;
export const ThumbnailBoxSchema = z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(), width: z.number().positive(), height: z.number().positive() });
export const ThumbnailCreateSchema = z.object({
  frameSeconds: z.number().nonnegative().optional(),
  sourceHeadlineCardId: z.string().min(1).max(80).nullable().default(null),
  brandAssetId: z.string().uuid().nullable().default(null),
  segmentationProvider: z.enum(thumbnailSegmentationProviders).optional(),
  positiveBox: ThumbnailBoxSchema.nullable().default(null),
  negativeBoxes: z.array(ThumbnailBoxSchema).max(32).default([]),
});
export const ThumbnailManifestSchema = z.object({
  schema: z.literal('axios.thumbnail.manifest.v1'),
  projectId: z.string().uuid(),
  candidateId: z.string().uuid(),
  sourceId: z.string().uuid(),
  frameSeconds: z.number().nonnegative(),
  dimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  segmentation: z.object({ provider: z.enum(thumbnailSegmentationProviders), positiveBox: ThumbnailBoxSchema.nullable(), negativeBoxes: z.array(ThumbnailBoxSchema) }),
  headlineCard: z.object({ id: z.string(), text: z.string(), color: z.string().nullable() }).nullable(),
  branding: z.object({ brandAssetId: z.string().uuid().nullable(), assetId: z.string().uuid().nullable() }),
  assets: z.object({
    sourceFrame: z.object({ key: z.string(), assetId: z.string().uuid().nullable() }),
    subject: z.object({ key: z.string(), assetId: z.string().uuid().nullable() }),
    preview: z.object({ key: z.string(), assetId: z.string().uuid().nullable() }),
    manifest: z.object({ key: z.string() }),
    export: z.object({ key: z.string(), assetId: z.string().uuid().nullable() }),
  }),
  createdAt: z.string().datetime(),
});
export const ThumbnailProjectSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  sourceId: z.string().uuid(),
  frameSeconds: z.number().nonnegative(),
  sourceHeadlineCardId: z.string().nullable(),
  brandAssetId: z.string().uuid().nullable(),
  segmentationProvider: z.enum(thumbnailSegmentationProviders),
  positiveBox: ThumbnailBoxSchema.nullable(),
  negativeBoxes: z.array(ThumbnailBoxSchema),
  manifest: ThumbnailManifestSchema.nullable(),
  sourceFrameAssetId: z.string().uuid().nullable(),
  subjectAssetId: z.string().uuid().nullable(),
  previewAssetId: z.string().uuid().nullable(),
  exportAssetId: z.string().uuid().nullable(),
  sourceFrameUrl: z.string().nullable(),
  subjectUrl: z.string().nullable(),
  previewUrl: z.string().nullable(),
  exportUrl: z.string().nullable(),
  status: z.enum(thumbnailProjectStates),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const ThumbnailJobSchema = z.object({ id: z.string().uuid(), thumbnailProjectId: z.string().uuid(), status: z.enum(jobStates), progress: z.number().int().min(0).max(100), attempts: z.number().int().nonnegative(), claimedAt: z.string().datetime().nullable(), leaseExpiresAt: z.string().datetime().nullable(), error: z.string().nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export type ThumbnailCreate = z.infer<typeof ThumbnailCreateSchema>; export type ThumbnailManifest = z.infer<typeof ThumbnailManifestSchema>; export type ThumbnailProject = z.infer<typeof ThumbnailProjectSchema>; export type ThumbnailJob = z.infer<typeof ThumbnailJobSchema>;
export const validTransition = (from: typeof jobStates[number], to: typeof jobStates[number]) => ({ queued: ['processing', 'cancelled'], processing: ['queued', 'completed', 'failed', 'cancelled'], completed: [], failed: [], cancelled: [] }[from] as string[]).includes(to);
