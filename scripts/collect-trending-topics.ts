import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildTrendSnapshot, type YouTubeVideo, type XTrend, youtubeContributions, xContributions } from './trending.js';

const youtubeKey = process.env.YOUTUBE_DATA_API_KEY?.trim();
const xBearerToken = process.env.X_BEARER_TOKEN?.trim();
const region = process.env.TREND_REGION?.trim() || 'US';
const woeid = process.env.X_TRENDS_WOEID?.trim() || '23424977';
const limit = Math.min(Math.max(Number(process.env.TREND_TOPIC_LIMIT ?? 12) || 12, 1), 100);
const outputPath = process.env.TREND_SNAPSHOT_FILE?.trim() || '/tmp/latest-trends.json';
const apiUrl = process.env.TREND_API_URL?.trim();

if (!youtubeKey) throw new Error('Set YOUTUBE_DATA_API_KEY for the trend collector.');
if (!xBearerToken) throw new Error('Set X_BEARER_TOKEN for the trend collector.');

async function fetchJson<T>(url: URL, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Trend source failed (${response.status}) for ${url.hostname}: ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

async function fetchYouTubeCategory(categoryId: string): Promise<YouTubeVideo[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,statistics');
  url.searchParams.set('chart', 'mostPopular');
  url.searchParams.set('regionCode', region);
  url.searchParams.set('videoCategoryId', categoryId);
  url.searchParams.set('maxResults', '50');
  url.searchParams.set('key', youtubeKey as string);
  const payload = await fetchJson<{ items?: YouTubeVideo[] }>(url);
  return payload.items ?? [];
}

async function fetchXTrends(): Promise<XTrend[]> {
  const url = new URL(`https://api.x.com/2/trends/by/woeid/${encodeURIComponent(woeid)}`);
  url.searchParams.set('max_trends', '50');
  url.searchParams.set('trend.fields', 'trend_name,tweet_count');
  const payload = await fetchJson<{ data?: XTrend[] }>(url, {
    headers: { authorization: `Bearer ${xBearerToken as string}` },
  });
  return payload.data ?? [];
}

async function fetchPreviousRanks(): Promise<Map<string, number>> {
  if (!apiUrl) return new Map();
  const url = new URL('/v1/trending/topics', apiUrl);
  url.searchParams.set('source', 'combined');
  url.searchParams.set('region', region);
  const payload = await fetchJson<{ items?: Array<{ topic?: string; rank?: number; keywords?: string[] }> }>(url);
  const ranks = new Map<string, number>();
  for (const item of payload.items ?? []) {
    const rank = Number(item.rank);
    if (item.topic && Number.isInteger(rank) && rank > 0) ranks.set(item.topic.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''), rank);
    for (const keyword of item.keywords ?? []) {
      if (Number.isInteger(rank) && rank > 0) ranks.set(keyword.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''), rank);
    }
  }
  return ranks;
}

const [newsVideos, technologyVideos, xTrends, previousRanks] = await Promise.all([
  fetchYouTubeCategory('25'),
  fetchYouTubeCategory('28'),
  fetchXTrends(),
  fetchPreviousRanks(),
]);
const contributions = [
  ...youtubeContributions(newsVideos, 'News & Politics'),
  ...youtubeContributions(technologyVideos, 'Science & Technology'),
  ...xContributions(xTrends),
];
const snapshot = buildTrendSnapshot(contributions, {
  region,
  limit,
  capturedAt: new Date().toISOString(),
  previousRanks,
});
if (!snapshot.topics.length) throw new Error('No politics/AI trends were found in the configured source feeds.');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, region, topicCount: snapshot.topics.length, topics: snapshot.topics.map((topic) => topic.topic) }));
