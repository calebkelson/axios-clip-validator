import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrendSnapshot, topicKey, xContributions, youtubeContributions } from './trending.js';

test('normalizes equivalent topic keys', () => {
  assert.equal(topicKey('#Open AI'), 'openai');
  assert.equal(topicKey('Sam   Altman'), 'samaltman');
});

test('extracts relevant YouTube topics and deduplicates video ids', () => {
  const contributions = youtubeContributions([
    {
      id: 'one',
      snippet: { title: 'OpenAI and Sam Altman announce a new model', categoryId: '28', tags: ['AI'] },
      statistics: { viewCount: '100000', likeCount: '1000', commentCount: '100' },
    },
    {
      id: 'one',
      snippet: { title: 'OpenAI and Sam Altman announce a new model', categoryId: '28' },
      statistics: { viewCount: '100000', likeCount: '1000', commentCount: '100' },
    },
  ], 'Science & Technology');
  assert.ok(contributions.some((item) => item.topic === 'OpenAI'));
  assert.equal(new Set(contributions.flatMap((item) => [...item.evidenceUrls])).size, 1);
});

test('filters X trends to politics and AI signals', () => {
  const contributions = xContributions([
    { trend_name: 'Trump', tweet_count: 10000 },
    { trend_name: 'OpenAI', tweet_count: 8000 },
    { trend_name: 'Local Sports', tweet_count: 100000 },
  ]);
  assert.deepEqual(contributions.map((item) => item.topic), ['Trump', 'OpenAI']);
});

test('ranks merged sources, marks movement, and recommends the leader', () => {
  const contributions = [
    ...xContributions([{ trend_name: 'OpenAI', tweet_count: 10000 }, { trend_name: 'Trump', tweet_count: 5000 }]),
    ...youtubeContributions([{ id: 'one', snippet: { title: 'OpenAI news', categoryId: '28' }, statistics: { viewCount: '900000' } }], 'Science & Technology'),
  ];
  const snapshot = buildTrendSnapshot(contributions, {
    region: 'US',
    limit: 5,
    capturedAt: '2026-08-17T00:00:00.000Z',
    previousRanks: new Map([['openai', 2]]),
  });
  assert.equal(snapshot.topics[0]?.topic, 'OpenAI');
  assert.equal(snapshot.topics[0]?.movement, 'up');
  assert.equal(snapshot.topics[0]?.dailyRecommendation, true);
  assert.equal(snapshot.topics[0]?.matchingClipCount, null);
});
