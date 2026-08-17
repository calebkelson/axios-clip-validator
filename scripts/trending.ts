export type TrendMovement = 'up' | 'down' | 'steady' | 'new';

export type TrendTopic = {
  topic: string;
  keywords: string[];
  summary: string;
  rank: number;
  previousRank: number | null;
  movement: TrendMovement;
  signalStrength: number;
  matchingClipCount: null;
  dailyRecommendation: boolean;
  sourceLabels: string[];
  evidenceUrls: string[];
  raw: Record<string, unknown>;
};

export type TrendSnapshot = {
  source: 'combined';
  region: string;
  capturedAt: string;
  topics: TrendTopic[];
};

export type YouTubeVideo = {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    tags?: string[];
    categoryId?: string;
    publishedAt?: string;
    channelTitle?: string;
  };
  statistics?: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
  };
};

type SourceContribution = {
  source: 'youtube';
  topic: string;
  keywords: Set<string>;
  sourceLabels: Set<string>;
  evidenceUrls: Set<string>;
  score: number;
  raw: Record<string, unknown>;
};

type Aggregate = {
  topic: string;
  key: string;
  keywords: Set<string>;
  sourceLabels: Set<string>;
  evidenceUrls: Set<string>;
  contributions: SourceContribution[];
  score: number;
  raw: Record<string, unknown>[];
};

const POLITICS_TERMS = [
  'trump', 'donald trump', 'president', 'white house', 'congress', 'senate', 'house of representatives',
  'election', 'elections', 'democrat', 'democrats', 'republican', 'republicans', 'gop', 'tariff', 'tariffs',
  'iran', 'israel', 'gaza', 'ukraine', 'russia', 'nato', 'immigration', 'supreme court', 'government',
  'politics', 'political', 'kennedy', 'vance', 'biden', 'harris', 'news',
];

const AI_TERMS = [
  'ai', 'artificial intelligence', 'openai', 'chatgpt', 'sam altman', 'anthropic', 'claude', 'gemini',
  'deepmind', 'nvidia', 'copilot', 'machine learning', 'large language model', 'llm', 'robotics',
  'technology', 'tech',
];

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it', 'its', 'of',
  'on', 'or', 'the', 'their', 'this', 'to', 'with', 'why', 'what', 'when', 'where', 'who', 'will',
]);

const SEED_ALIASES: Array<{ label: string; aliases: string[] }> = [
  { label: 'Trump', aliases: ['trump', 'donald trump'] },
  { label: 'OpenAI', aliases: ['openai', 'open ai'] },
  { label: 'Sam Altman', aliases: ['sam altman'] },
  { label: 'ChatGPT', aliases: ['chatgpt', 'chat gpt'] },
  { label: 'Artificial intelligence', aliases: ['artificial intelligence', 'ai'] },
  { label: 'Nvidia', aliases: ['nvidia'] },
  { label: 'Congress', aliases: ['congress'] },
  { label: 'Election', aliases: ['election', 'elections'] },
  { label: 'Iran', aliases: ['iran'] },
  { label: 'Gaza', aliases: ['gaza'] },
];

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function normalizeTopic(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function topicKey(value: string): string {
  return normalizeTopic(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function containsTerm(value: string, terms: string[]): boolean {
  const haystack = value.toLocaleLowerCase();
  return terms.some((term) => haystack.includes(term));
}

function canonicalSeed(value: string): string | null {
  const lower = value.toLocaleLowerCase();
  const match = SEED_ALIASES.find((seed) => seed.aliases.some((alias) => lower.includes(alias)));
  return match?.label ?? null;
}

function signalFromRank(index: number, total: number): number {
  if (total <= 1) return 100;
  return Math.max(35, Math.round(100 - (index / (total - 1)) * 65));
}

function logScore(value: number, max: number): number {
  if (!value || !max) return 0;
  return Math.min(100, Math.round((Math.log10(value + 1) / Math.log10(max + 1)) * 100));
}

function safeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function titleTopic(title: string): string {
  const words = normalizeTopic(title)
    .replace(/[|:;!?()[\]{}]+/g, ' ')
    .split(/\s+/)
    .filter((word) => !STOP_WORDS.has(word.toLocaleLowerCase()));
  return normalizeTopic(words.slice(0, 7).join(' '));
}

function addContribution(
  map: Map<string, Aggregate>,
  contribution: SourceContribution,
): void {
  const key = topicKey(contribution.topic);
  if (!key) return;
  const existing = map.get(key);
  if (existing) {
    existing.keywords = new Set([...existing.keywords, ...contribution.keywords]);
    existing.sourceLabels = new Set([...existing.sourceLabels, ...contribution.sourceLabels]);
    existing.evidenceUrls = new Set([...existing.evidenceUrls, ...contribution.evidenceUrls]);
    existing.contributions.push(contribution);
    existing.raw.push(contribution.raw);
    existing.score += contribution.score;
    return;
  }
  map.set(key, {
    topic: contribution.topic,
    key,
    keywords: new Set(contribution.keywords),
    sourceLabels: new Set(contribution.sourceLabels),
    evidenceUrls: new Set(contribution.evidenceUrls),
    contributions: [contribution],
    score: contribution.score,
    raw: [contribution.raw],
  });
}

function youtubeTopicCandidates(video: YouTubeVideo): string[] {
  const snippet = video.snippet ?? {};
  const title = text(snippet.title);
  const combined = [title, text(snippet.description), ...(snippet.tags ?? [])].join(' ');
  const candidates = new Set<string>();
  const hashtags = combined.match(/#[\p{L}\p{N}_-]+/gu) ?? [];
  for (const hashtag of hashtags) candidates.add(normalizeTopic(hashtag));
  const seed = canonicalSeed(combined);
  if (seed) candidates.add(seed);
  const derivedTitle = titleTopic(title);
  if (derivedTitle) candidates.add(derivedTitle);
  return [...candidates].filter((candidate) => candidate.length >= 2 && candidate.length <= 80);
}

export function youtubeContributions(
  videos: YouTubeVideo[],
  categoryLabel: string,
): SourceContribution[] {
  const deduped = new Map<string, YouTubeVideo>();
  for (const video of videos) {
    const id = text(video.id);
    if (id && !deduped.has(id)) deduped.set(id, video);
  }
  const values = [...deduped.values()];
  const maxViews = Math.max(...values.map((video) => safeNumber(video.statistics?.viewCount)), 0);
  const maxEngagement = Math.max(...values.map((video) => safeNumber(video.statistics?.likeCount) + safeNumber(video.statistics?.commentCount)), 0);
  const contributions: SourceContribution[] = [];
  values.forEach((video, index) => {
    const snippet = video.snippet ?? {};
    const sourceText = [text(snippet.title), text(snippet.description), ...(snippet.tags ?? [])].join(' ');
    const relevant = containsTerm(sourceText, [...POLITICS_TERMS, ...AI_TERMS]);
    if (!relevant && !categoryLabel.startsWith('YouTube newest') && !categoryLabel.startsWith('YouTube popular')) return;
    const viewScore = logScore(safeNumber(video.statistics?.viewCount), maxViews);
    const engagementScore = logScore(safeNumber(video.statistics?.likeCount) + safeNumber(video.statistics?.commentCount), maxEngagement);
    const score = Math.round(signalFromRank(index, values.length) * 0.55 + viewScore * 0.3 + engagementScore * 0.15);
    const videoId = text(video.id);
    for (const candidate of youtubeTopicCandidates(video)) {
      const canonical = canonicalSeed(candidate) ?? candidate;
      contributions.push({
        source: 'youtube',
        topic: canonical,
        keywords: new Set([canonical, candidate, text(snippet.title)].filter(Boolean)),
        sourceLabels: new Set(['youtube', categoryLabel.startsWith('YouTube newest') ? 'YouTube newest' : 'YouTube popular', categoryLabel.includes('News & Politics') ? 'News & Politics' : 'Science & Technology']),
        evidenceUrls: new Set(videoId ? [`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`] : []),
        score,
        raw: {
          source: 'youtube',
          category: categoryLabel,
          videoId: videoId || null,
          title: text(snippet.title),
          channelTitle: text(snippet.channelTitle),
          publishedAt: text(snippet.publishedAt),
          viewCount: safeNumber(video.statistics?.viewCount),
          likeCount: safeNumber(video.statistics?.likeCount),
          commentCount: safeNumber(video.statistics?.commentCount),
        },
      });
    }
  });
  return contributions;
}

function movement(previousRank: number | null, rank: number): TrendMovement {
  if (previousRank === null) return 'new';
  if (rank < previousRank) return 'up';
  if (rank > previousRank) return 'down';
  return 'steady';
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function summaryFor(aggregate: Aggregate, capturedAt: string): string {
  const labels = [...aggregate.sourceLabels];
  const sample = aggregate.raw.find((raw) => text(raw.title))?.title;
  const views = Math.max(...aggregate.raw.map((raw) => safeNumber(raw.viewCount)), 0);
  const engagement = Math.max(...aggregate.raw.map((raw) => safeNumber(raw.likeCount) + safeNumber(raw.commentCount)), 0);
  const publishedTimes = aggregate.raw
    .map((raw) => Date.parse(text(raw.publishedAt)))
    .filter((time) => Number.isFinite(time));
  const newestTime = Math.max(...publishedTimes, 0);
  const capturedTime = Date.parse(capturedAt);
  const ageHours = newestTime && Number.isFinite(capturedTime) ? Math.max(0, Math.round((capturedTime - newestTime) / 3_600_000)) : null;
  const reasons = [];
  if (labels.includes('YouTube newest') && ageHours !== null) reasons.push(ageHours <= 24 ? 'new coverage appeared within the last day' : `new coverage appeared about ${ageHours} hours ago`);
  if (labels.includes('YouTube popular')) reasons.push('it is also appearing in YouTube’s popular feed');
  if (views > 0) reasons.push(`the leading video has about ${formatCount(views)} views`);
  if (engagement > 0) reasons.push(`with about ${formatCount(engagement)} likes and comments`);
  const reasonText = reasons.length ? reasons.join(', ') : 'it is appearing repeatedly in the tracked YouTube feeds';
  return `Trending on YouTube because ${reasonText}${sample ? `. Related coverage: “${sample}”.` : '.'}`;
}

export function buildTrendSnapshot(
  contributions: SourceContribution[],
  options: { region: string; limit: number; capturedAt: string; previousRanks?: Map<string, number> },
): TrendSnapshot {
  const aggregates = new Map<string, Aggregate>();
  for (const contribution of contributions) addContribution(aggregates, contribution);
  const ranked = [...aggregates.values()]
    .map((aggregate) => ({ aggregate, score: Math.min(100, Math.round(aggregate.score / Math.max(1, aggregate.contributions.length) + Math.min(20, (aggregate.contributions.length - 1) * 8))) }))
    .sort((left, right) => right.score - left.score || left.aggregate.topic.localeCompare(right.aggregate.topic))
    .slice(0, options.limit);
  const topics = ranked.map(({ aggregate, score }, index) => {
    const rank = index + 1;
    const previousRank = options.previousRanks?.get(aggregate.key) ?? null;
    return {
      topic: aggregate.topic,
      keywords: [...aggregate.keywords].slice(0, 12),
      summary: summaryFor(aggregate, options.capturedAt),
      rank,
      previousRank,
      movement: movement(previousRank, rank),
      signalStrength: score,
      matchingClipCount: null,
      dailyRecommendation: rank === 1,
      sourceLabels: [...aggregate.sourceLabels],
      evidenceUrls: [...aggregate.evidenceUrls].slice(0, 12),
      raw: { contributions: aggregate.raw, score },
    };
  });
  return { source: 'combined', region: options.region, capturedAt: options.capturedAt, topics };
}
