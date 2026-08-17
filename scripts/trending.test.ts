import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrendSnapshot, topicKey, youtubeContributions } from './trending.js';

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

test('builds a plain-language summary from newest and popular YouTube signals', () => {
  const snapshot = buildTrendSnapshot(youtubeContributions([
    {
      id: 'one',
      snippet: { title: 'OpenAI releases a new model', categoryId: '28', publishedAt: '2026-08-17T00:00:00.000Z' },
      statistics: { viewCount: '125000', likeCount: '3000', commentCount: '200' },
    },
  ], 'YouTube newest · Science & Technology').concat(youtubeContributions([
    {
      id: 'one',
      snippet: { title: 'OpenAI releases a new model', categoryId: '28', publishedAt: '2026-08-17T00:00:00.000Z' },
      statistics: { viewCount: '125000', likeCount: '3000', commentCount: '200' },
    },
  ], 'YouTube popular · Science & Technology')), {
    region: 'US',
    limit: 5,
    capturedAt: '2026-08-17T06:00:00.000Z',
  });
  assert.match(snapshot.topics[0]?.summary ?? '', /new coverage appeared within the last day/);
  assert.match(snapshot.topics[0]?.summary ?? '', /popular feed/);
  assert.match(snapshot.topics[0]?.summary ?? '', /125\.0K views/);
});

test('ranks merged sources, marks movement, and recommends the leader', () => {
  const contributions = youtubeContributions([{ id: 'one', snippet: { title: 'OpenAI news', categoryId: '28' }, statistics: { viewCount: '900000' } }], 'YouTube popular · Science & Technology');
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
