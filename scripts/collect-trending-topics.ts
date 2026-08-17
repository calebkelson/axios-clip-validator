import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildTrendSnapshot, type YouTubeVideo, youtubeContributions } from './trending.js';
import { enrichTrendSnapshot } from './trend-context.js';

const youtubeKey = process.env.YOUTUBE_DATA_API_KEY?.trim();
const region = process.env.TREND_REGION?.trim() || 'US';
const limit = Math.min(Math.max(Number(process.env.TREND_TOPIC_LIMIT ?? 12) || 12, 1), 100);
const latestWindowHours = Math.min(Math.max(Number(process.env.TREND_LATEST_WINDOW_HOURS ?? 72) || 72, 1), 168);
const latestResults = Math.min(Math.max(Number(process.env.TREND_LATEST_RESULTS ?? 25) || 25, 1), 50);
const outputPath = process.env.TREND_SNAPSHOT_FILE?.trim() || '/tmp/latest-trends.json';
const apiUrl = process.env.TREND_API_URL?.trim();
const summaryLimit = Math.min(Math.max(Number(process.env.TREND_SUMMARY_LIMIT ?? limit) || limit, 0), limit);
const webContextEnabled = process.env.TREND_NEWS_CONTEXT_ENABLED?.trim().toLowerCase() !== 'false';

if (!youtubeKey) throw new Error('Set YOUTUBE_DATA_API_KEY for the trend collector.');

async function fetchJson<T>(url: URL, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Trend source failed (${response.status}) for ${url.hostname}: ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

type SearchItem = { id?: { videoId?: string }; snippet?: YouTubeVideo['snippet'] };

async function fetchYouTubeLatestCategory(categoryId: string, fallbackQuery: string): Promise<YouTubeVideo[]> {
  const search = async (useWindow: boolean, query?: string): Promise<SearchItem[]> => {
  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.searchParams.set('part', 'snippet');
  searchUrl.searchParams.set('type', 'video');
  searchUrl.searchParams.set('order', 'date');
  if (useWindow) searchUrl.searchParams.set('publishedAfter', new Date(Date.now() - latestWindowHours * 60 * 60 * 1000).toISOString());
  if (query) searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('regionCode', region);
  searchUrl.searchParams.set('videoCategoryId', categoryId);
  searchUrl.searchParams.set('maxResults', String(latestResults));
  searchUrl.searchParams.set('relevanceLanguage', 'en');
  searchUrl.searchParams.set('key', youtubeKey as string);
  const searchPayload = await fetchJson<{ items?: SearchItem[] }>(searchUrl);
    return searchPayload.items ?? [];
  };

  let searchItems = await search(true);
  if (!searchItems.length) {
    console.warn(`No recent YouTube results for category ${categoryId}; retrying without the ${latestWindowHours}-hour cutoff.`);
    searchItems = await search(false);
  }
  if (!searchItems.length) {
    console.warn(`No YouTube results for category ${categoryId}; retrying with query ${fallbackQuery}.`);
    searchItems = await search(false, fallbackQuery);
  }
  const seedVideos = searchItems
    .map((item) => ({ id: item.id?.videoId, snippet: item.snippet }))
    .filter((video): video is YouTubeVideo => Boolean(video.id));
  const ids = seedVideos.map((video) => video.id as string);
  if (!ids.length) return [];

  const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  detailsUrl.searchParams.set('part', 'snippet,statistics');
  detailsUrl.searchParams.set('id', ids.join(','));
  detailsUrl.searchParams.set('key', youtubeKey as string);
  const detailsPayload = await fetchJson<{ items?: YouTubeVideo[] }>(detailsUrl);
  const byId = new Map((detailsPayload.items ?? []).map((video) => [video.id, video]));
  return seedVideos.map((video) => ({ ...video, ...(byId.get(video.id) ?? {}) }));
}

async function fetchPreviousRanks(): Promise<Map<string, number>> {
  if (!apiUrl) return new Map();
  try {
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
  } catch (error) {
    console.warn(`Previous trend ranks unavailable; continuing without movement history: ${error instanceof Error ? error.message : String(error)}`);
    return new Map();
  }
}

const settled = await Promise.allSettled([
  fetchYouTubeLatestCategory('25', 'politics'),
  fetchYouTubeLatestCategory('28', 'AI'),
  fetchPreviousRanks(),
]);
const [newsLatest, technologyLatest, previousRanks] = settled.map((result) => {
  if (result.status === 'fulfilled') return result.value;
  console.warn(`Trend input unavailable; continuing with the remaining sources: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  return result === settled[2] ? new Map<string, number>() : [];
}) as [YouTubeVideo[], YouTubeVideo[], Map<string, number>];
const contributions = [
  ...youtubeContributions(newsLatest, 'YouTube newest · News & Politics'),
  ...youtubeContributions(technologyLatest, 'YouTube newest · Science & Technology'),
];
let snapshot = buildTrendSnapshot(contributions, {
  region,
  limit,
  capturedAt: new Date().toISOString(),
  previousRanks,
});
if (!snapshot.topics.length) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ skipPublish: true, reason: 'No fresh YouTube politics/AI metadata was available.', capturedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  console.warn('No fresh YouTube politics/AI metadata was available; the Cron run will complete without publishing an empty snapshot.');
  process.exit(0);
}
snapshot = await enrichTrendSnapshot(snapshot, region, summaryLimit, webContextEnabled);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, region, topicCount: snapshot.topics.length, topics: snapshot.topics.map((topic) => topic.topic) }));
