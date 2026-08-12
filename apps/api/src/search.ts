const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how',
  'i', 'in', 'is', 'it', 'me', 'of', 'on', 'or', 'that', 'the', 'this',
  'to', 'was', 'what', 'when', 'where', 'who', 'why', 'with', 'would', 'about',
]);

const SEARCH_SYNONYMS: Record<string, string[]> = {
  ai: ['artificial intelligence', 'machine learning', 'chatgpt', 'openai', 'automation'],
  artificial: ['ai', 'machine learning', 'automation'],
  chips: ['semiconductors', 'processors', 'gpu', 'hardware', 'silicon'],
  climate: ['global warming', 'emissions', 'weather', 'carbon', 'environment'],
  economy: ['economic', 'inflation', 'jobs', 'growth', 'recession', 'markets'],
  jobs: ['employment', 'workers', 'labor', 'careers', 'workforce'],
  nvidia: ['gpu', 'graphics processing unit', 'semiconductors', 'chips', 'cuda', 'data center'],
  politics: ['government', 'election', 'congress', 'policy', 'republican', 'democrat'],
  trump: ['president', 'white house', 'republican', 'administration'],
  youtube: ['video', 'creator', 'channel', 'viewers'],
};

export type SearchPlan = {
  exactPhrase: string;
  exactTerms: string[];
  relatedTerms: string[];
  source: 'model' | 'fallback';
};

export function normalizeSearchText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 160);
}

export function tokenizeSearchQuery(value: string): string[] {
  const tokens = normalizeSearchText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token));
  return [...new Set(tokens)].slice(0, 12);
}

function cleanTerms(values: unknown, limit: number): string[] {
  if (!Array.isArray(values)) return [];
  const terms = values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => normalizeSearchText(value).toLowerCase())
    .filter((value) => value.length >= 2 && value.length <= 80 && !SEARCH_STOP_WORDS.has(value));
  return [...new Set(terms)].slice(0, limit);
}

export function fallbackSearchPlan(query: string): SearchPlan {
  const exactPhrase = normalizeSearchText(query);
  const exactTerms = tokenizeSearchQuery(exactPhrase);
  const relatedTerms = [...new Set(exactTerms.flatMap((term) => SEARCH_SYNONYMS[term] ?? []))]
    .filter((term) => !exactTerms.includes(term))
    .slice(0, 24);
  return { exactPhrase, exactTerms, relatedTerms, source: 'fallback' };
}

function modelSearchPlan(query: string, payload: unknown): SearchPlan | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  const exactPhrase = normalizeSearchText(typeof value.exactPhrase === 'string' ? value.exactPhrase : query);
  const exactTerms = cleanTerms(value.exactTerms, 12);
  const relatedTerms = cleanTerms(value.relatedTerms, 24).filter((term) => !exactTerms.includes(term));
  if (!exactPhrase || !exactTerms.length) return null;
  return { exactPhrase, exactTerms, relatedTerms, source: 'model' };
}

type SearchExpansionConfig = {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
};

const searchCache = new Map<string, { expiresAt: number; plan: SearchPlan }>();
const searchInflight = new Map<string, Promise<SearchPlan>>();

export async function expandSearchQuery(query: string, config: SearchExpansionConfig = {}): Promise<SearchPlan> {
  const fallback = fallbackSearchPlan(query);
  if (!fallback.exactPhrase || !fallback.exactTerms.length) return fallback;

  const cacheKey = fallback.exactPhrase.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.plan;
  if (searchInflight.has(cacheKey)) return searchInflight.get(cacheKey)!;

  const apiKey = config.apiKey?.trim();
  if (!apiKey) return fallback;

  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(250, config.timeoutMs ?? 700));
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.model ?? 'gpt-4o-mini',
          temperature: 0,
          max_tokens: 180,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'You expand newsroom search queries. Return JSON only with exactPhrase, exactTerms, and relatedTerms. Preserve names and products exactly in exactTerms. Add only concrete synonyms, aliases, entities, topics, and abbreviations likely to appear in clip headlines, source titles, captions, hashtags, or transcripts. Never add broad filler words. Maximum 12 exactTerms and 24 relatedTerms.',
            },
            { role: 'user', content: JSON.stringify({ query: fallback.exactPhrase }) },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) return fallback;
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) return fallback;
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return fallback;
      }
      return modelSearchPlan(fallback.exactPhrase, parsed) ?? fallback;
    } catch {
      return fallback;
    } finally {
      clearTimeout(timeout);
    }
  })();

  searchInflight.set(cacheKey, request);
  try {
    const plan = await request;
    searchCache.set(cacheKey, { expiresAt: Date.now() + Math.max(30_000, config.cacheTtlMs ?? 300_000), plan });
    return plan;
  } finally {
    searchInflight.delete(cacheKey);
  }
}
