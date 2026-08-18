import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import type { AssetStore } from '@clipper/storage';
import { buildApp } from './app.js';

const fakeStore = {} as AssetStore;

async function captureQueueQuery(url: string) {
  const state: { captured?: { sql: string; params: unknown[] } } = {};
  const fakeDb = {
    query: async (sql: string, params: unknown[] = []) => {
      state.captured = { sql, params };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  const app = buildApp(fakeDb, fakeStore);
  await app.ready();
  try {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200);
    if (!state.captured) throw new Error('The queue query was not captured.');
    return state.captured;
  } finally {
    await app.close();
  }
}

test('the unsearched queue ranks clips by quality before recency', async () => {
  const query = await captureQueueQuery('/v1/dashboard/queue?stage=ready&limit=5');
  assert.match(query.sql, /COALESCE\(c\.confidence, 0\) \* 45/);
  assert.match(query.sql, /y\.view_count/);
  assert.match(query.sql, /ORDER BY quality_rank DESC NULLS LAST, c\.score DESC NULLS LAST, c\.confidence DESC NULLS LAST/);
  assert.match(query.sql, /r\.status = 'completed'/);
});

test('search ranking puts keyword relevance before the quality ranking', async () => {
  const query = await captureQueueQuery('/v1/dashboard/queue?q=Trump&limit=5');
  assert.match(query.sql, /search_rank DESC, quality_rank DESC NULLS LAST/);
  assert.deepEqual(query.params.slice(0, 7), [null, null, 6, 'Trump', ['trump'], ['president', 'white house', 'republican', 'administration'], 0]);
});

test('clip search uses the same relevance-then-quality ordering', async () => {
  const query = await captureQueueQuery('/v1/clips/search?q=Trump');
  assert.match(query.sql, /search_rank DESC, quality_rank DESC NULLS LAST/);
});
