import type { TrendSnapshot, TrendTopic } from './trending.js';

export type NewsEvidence = {
  title: string;
  description: string;
  url: string;
  publishedAt: string | null;
  source: string | null;
};

export type TrendEnrichment = {
  whatHappened: string;
  whyTrending: string;
  figures: string[];
  confidence: 'high' | 'medium' | 'low';
  sources: NewsEvidence[];
  provider: 'openai' | 'metadata';
};

const FIGURE_ALIASES = [
  'Donald Trump', 'Trump', 'Sam Altman', 'Jensen Huang', 'Elon Musk', 'Mark Zuckerberg',
  'Sundar Pichai', 'Demis Hassabis', 'Dario Amodei', 'Joe Biden', 'Kamala Harris',
  'JD Vance', 'Vance', 'Benjamin Netanyahu', 'Vladimir Putin', 'Volodymyr Zelenskyy',
];

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function xmlTag(item: string, tag: string): string {
  const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

export function parseGoogleNewsRss(xml: string, maxResults = 5): NewsEvidence[] {
  const items: NewsEvidence[] = [];
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    const title = xmlTag(item, 'title');
    const url = xmlTag(item, 'link');
    if (!title || !url) continue;
    items.push({
      title,
      description: xmlTag(item, 'description'),
      url,
      publishedAt: xmlTag(item, 'pubDate') || null,
      source: xmlTag(item, 'source') || null,
    });
    if (items.length >= maxResults) break;
  }
  return items;
}

export async function fetchGoogleNewsRss(
  query: string,
  region: string,
  maxResults: number,
): Promise<NewsEvidence[]> {
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', query);
  url.searchParams.set('hl', 'en-US');
  url.searchParams.set('gl', region);
  url.searchParams.set('ceid', `${region}:en`);
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Google News RSS failed (${response.status})`);
  return parseGoogleNewsRss(await response.text(), maxResults);
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  const boundary = normalized.slice(0, maxLength - 1).lastIndexOf(' ');
  return `${normalized.slice(0, boundary > 40 ? boundary : maxLength - 1).trim()}…`;
}

function topicEvidence(topic: TrendTopic): Array<Record<string, unknown>> {
  const raw = topic.raw?.contributions;
  return Array.isArray(raw) ? raw.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : [];
}

export function detectFigures(topic: TrendTopic, news: NewsEvidence[]): string[] {
  const evidenceText = [
    topic.topic,
    ...topic.keywords,
    ...topicEvidence(topic).flatMap((item) => [text(item.title), text(item.channelTitle)]),
    ...news.flatMap((item) => [item.title, item.description]),
  ].join(' ').toLocaleLowerCase();
  return FIGURE_ALIASES.filter((figure) => evidenceText.includes(figure.toLocaleLowerCase()));
}

export function topicSearchQuery(topic: TrendTopic): string {
  return [topic.topic, ...topic.keywords.slice(0, 3)].filter(Boolean).join(' ');
}

function fallbackEnrichment(topic: TrendTopic, news: NewsEvidence[], figures: string[]): TrendEnrichment {
  const videos = topicEvidence(topic);
  const videoTitles = videos.map((item) => text(item.title)).filter(Boolean);
  const leadTitle = news[0]?.title || videoTitles[0] || `${topic.topic} coverage`;
  const videoCount = new Set(videos.map((item) => text(item.videoId)).filter(Boolean)).size || videoTitles.length;
  const sourceCount = news.length + videoCount;
  const views = Math.max(...videos.map((item) => Number(item.viewCount) || 0), 0);
  const viewText = views >= 1_000_000
    ? `${(views / 1_000_000).toFixed(1)}M`
    : views >= 1_000
      ? `${(views / 1_000).toFixed(1)}K`
      : views.toLocaleString();
  const whatHappened = news.length
    ? `Recent coverage is focused on “${truncate(leadTitle, 190)}”.`
    : `Recent YouTube coverage is focused on ${topic.topic}.`;
  const whyTrending = `${sourceCount || 1} recent source${sourceCount === 1 ? '' : 's'} are covering the topic${views > 0 ? `, with the leading YouTube video at about ${viewText} views` : ''}.`;
  return { whatHappened, whyTrending, figures, confidence: news.length >= 2 ? 'medium' : 'low', sources: news, provider: 'metadata' };
}

function readJsonContent(body: Record<string, unknown>): Record<string, unknown> | null {
  const choices = body.choices;
  if (!Array.isArray(choices)) return null;
  const message = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>).message : null;
  const content = message && typeof message === 'object' ? (message as Record<string, unknown>).content : null;
  if (typeof content !== 'string') return null;
  try {
    const normalized = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(normalized) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function modelText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? truncate(value, 280) : fallback;
}

async function summarizeWithOpenAI(topic: TrendTopic, news: NewsEvidence[], figures: string[]): Promise<TrendEnrichment | null> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const model = process.env.TREND_SUMMARY_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || process.env.OPENAI_TITLE_MODEL?.trim() || 'gpt-5';
  const videos = topicEvidence(topic).slice(0, 8).map((item) => ({
    title: text(item.title), channel: text(item.channelTitle), publishedAt: text(item.publishedAt), views: Number(item.viewCount) || 0,
  }));
  const prompt = `You summarize a current politics/AI trend for an editorial clip-review dashboard. Use only the evidence below. Do not invent or state an unverified claim as fact. If evidence conflicts or is thin, attribute it as reports/coverage and set confidence to low. Return JSON only with exactly: whatHappened (1-2 sentences), whyTrending (1 sentence), figures (array of names explicitly present in evidence), confidence (high, medium, or low). The summary must explain the specific event or subject, not merely say it has views.\n\nTOPIC: ${topic.topic}\nKEYWORDS: ${topic.keywords.join(', ')}\nKNOWN FIGURES: ${figures.join(', ') || 'none'}\nYOUTUBE EVIDENCE:\n${JSON.stringify(videos)}\nNEWS EVIDENCE:\n${JSON.stringify(news.slice(0, 6))}`;
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_completion_tokens: 500,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`OpenAI ${response.status}`);
    const result = readJsonContent(body);
    if (!result) throw new Error('OpenAI returned invalid trend summary JSON');
    const reportedFigures = Array.isArray(result.figures) ? result.figures.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 8) : [];
    const allowedText = JSON.stringify({ topic, news, videos }).toLocaleLowerCase();
    const safeFigures = reportedFigures.filter((figure) => allowedText.includes(figure.toLocaleLowerCase()));
    return {
      whatHappened: modelText(result.whatHappened, fallbackEnrichment(topic, news, figures).whatHappened),
      whyTrending: modelText(result.whyTrending, fallbackEnrichment(topic, news, figures).whyTrending),
      figures: [...new Set([...figures, ...safeFigures])].slice(0, 8),
      confidence: result.confidence === 'high' || result.confidence === 'medium' || result.confidence === 'low' ? result.confidence : 'low',
      sources: news,
      provider: 'openai',
    };
  } catch (error) {
    console.warn(`Trend model summary unavailable for ${topic.topic}; using evidence fallback: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function enrichTrendTopic(topic: TrendTopic, news: NewsEvidence[]): Promise<TrendTopic> {
  const figures = detectFigures(topic, news);
  const fallback = fallbackEnrichment(topic, news, figures);
  const enrichment = await summarizeWithOpenAI(topic, news, figures) ?? fallback;
  const figureText = enrichment.figures.length ? ` Figures: ${enrichment.figures.join(', ')}.` : '';
  const summary = truncate(`What happened: ${enrichment.whatHappened} Why it's trending: ${enrichment.whyTrending}${figureText}`, 590);
  const newsUrls = enrichment.sources.map((item) => item.url);
  return {
    ...topic,
    summary,
    evidenceUrls: [...new Set([...topic.evidenceUrls, ...newsUrls])].slice(0, 20),
    raw: {
      ...topic.raw,
      eventSummary: enrichment.whatHappened,
      whyTrending: enrichment.whyTrending,
      figures: enrichment.figures,
      summaryConfidence: enrichment.confidence,
      summaryProvider: enrichment.provider,
      webContext: enrichment.sources,
    },
  };
}

export async function enrichTrendSnapshot(snapshot: TrendSnapshot, region: string, maxTopics: number, webContextEnabled = true): Promise<TrendSnapshot> {
  const topics = await Promise.all(snapshot.topics.map(async (topic, index) => {
    if (index >= maxTopics) return topic;
    try {
      const news = webContextEnabled ? await fetchGoogleNewsRss(topicSearchQuery(topic), region, 5) : [];
      return enrichTrendTopic(topic, news);
    } catch (error) {
      console.warn(`Web context unavailable for ${topic.topic}; using metadata fallback: ${error instanceof Error ? error.message : String(error)}`);
      return enrichTrendTopic(topic, []);
    }
  }));
  return { ...snapshot, topics };
}
