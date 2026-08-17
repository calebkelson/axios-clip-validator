import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildTrendSnapshot, type YouTubeVideo, youtubeContributions } from './trending.js';

const youtubeKey = process.env.YOUTUBE_DATA_API_KEY?.trim();
const region = process.env.TREND_REGION?.trim() || 'US';
const limit = Math.min(Math.max(Number(process.env.TREND_TOPIC_LIMIT ?? 12) || 12, 1), 100);
const latestWindowHours = Math.min(Math.max(Number(process.env.TREND_LATEST_WINDOW_HOURS ?? 72) || 72, 1), 168);
const latestResults = Math.min(Math.max(Number(process.env.TREND_LATEST_RESULTS ?? 25) || 25, 1), 50);
const outputPath = process.env.TREND_SNAPSHOT_FILE?.trim() || '/tmp/latest-trends.json';
const apiUrl = process.env.TREND_API_URL?.trim();

if (!youtubeKey) throw new Error('Set YOUTUBE_DATA_API_KEY for the trend collector.');

async function fetchJson<T>(url: URL, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Trend source failed (${response.status}) for ${url.hostname}: ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

async function fetchYouTubePopularCategory(categoryId: string): Promise<YouTubeVideo[]> {
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

async function fetchYouTubeLatestCategory(categoryId: string): Promise<YouTubeVideo[]> {
  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.searchParams.set('part', 'snippet');
  searchUrl.searchParams.set('type', 'video');
  searchUrl.searchParams.set('order', 'date');
  searchUrl.searchParams.set('publishedAfter', new Date(Date.now() - latestWindowHours * 60 * 60 * 1000).toISOString());
  searchUrl.searchParams.set('regionCode', region);
  searchUrl.searchParams.set('videoCategoryId', categoryId);
  searchUrl.searchParams.set('maxResults', String(latestResults));
  searchUrl.searchParams.set('relevanceLanguage', 'en');
  searchUrl.searchParams.set('key', youtubeKey as string);
  const searchPayload = await fetchJson<{ items?: Array<{ id?: { videoId?: string }; snippet?: YouTubeVideo['snippet'] }> }>(searchUrl);
  const ids = (searchPayload.items ?? []).map((item) => item.id?.videoId).filter((id): id is string => Boolean(id));
  if (!ids.length) return [];

  const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  detailsUrl.searchParams.set('part', 'snippet,statistics');
  detailsUrl.searchParams.set('id', ids.join(','));
  detailsUrl.searchParams.set('key', youtubeKey as string);
  const detailsPayload = await fetchJson<{ items?: YouTubeVideo[] }>(detailsUrl);
  const byId = new Map((detailsPayload.items ?? []).map((video) => [video.id, video]));
  return ids.map((id) => byId.get(id)).filter((video): video is YouTubeVideo => Boolean(video));
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

const [newsLatest, newsPopular, technologyLatest, technologyPopular, previousRanks] = await Promise.all([
  fetchYouTubeLatestCategory('25'),
  fetchYouTubePopularCategory('25'),
  fetchYouTubeLatestCategory('28'),
  fetchYouTubePopularCategory('28'),
  fetchPreviousRanks(),
]);
const contributions = [
  ...youtubeContributions(newsLatest, 'YouTube newest · News & Politics'),
  ...youtubeContributions(newsPopular, 'YouTube popular · News & Politics'),
  ...youtubeContributions(technologyLatest, 'YouTube newest · Science & Technology'),
  ...youtubeContributions(technologyPopular, 'YouTube popular · Science & Technology'),
];
const snapshot = buildTrendSnapshot(contributions, {
  region,
  limit,
  capturedAt: new Date().toISOString(),
  previousRanks,
});
if (!snapshot.topics.length) throw new Error('No YouTube politics/AI trends were found in the configured source feeds.');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, region, topicCount: snapshot.topics.length, topics: snapshot.topics.map((topic) => topic.topic) }));
