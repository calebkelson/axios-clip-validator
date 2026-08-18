import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import type { AssetStore } from '@clipper/storage';
import { buildApp } from './app.js';

const fakeStore = {} as AssetStore;

test('trending topics use stored match counts without fan-out clip scans', async () => {
  const calls: string[] = [];
  const fakeDb = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT id, source, region, captured_at, created_at')) {
        return {
          rows: [{ id: 'snapshot-1', source: 'combined', region: 'US', captured_at: new Date(), created_at: new Date() }],
          rowCount: 1,
        };
      }
      if (sql.includes('SELECT topic, keywords, summary, rank, previous_rank')) {
        return {
          rows: [{
            topic: 'AI', keywords: ['AI'], summary: 'summary', rank: 1, previous_rank: null,
            movement: 'new', signal_strength: 80, matching_clip_count: 7,
            daily_recommendation: true, source_labels: ['YouTube'], evidence_urls: [], raw: {},
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as pg.Pool;
  const app = buildApp(fakeDb, fakeStore);
  await app.ready();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/trending/topics' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items[0].matchingClipCount, 7);
    assert.equal(calls.length, 2);
  } finally {
    await app.close();
  }
});
