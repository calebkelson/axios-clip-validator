import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import type { AssetStore } from '@clipper/storage';
import { buildApp } from './app.js';

const fakeDb = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as pg.Pool;
const fakeStore = {} as AssetStore;
const siteOrigin = 'https://axios-clip-validator-new.axios.chatgpt.site';

test('allows the deployed site through CORS and handles preflight requests', async () => {
  const app = buildApp(fakeDb, fakeStore);
  await app.ready();
  try {
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/dashboard/queue',
      headers: {
        origin: siteOrigin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], siteOrigin);
    assert.equal(preflight.headers['access-control-allow-methods'], 'GET,POST,PATCH,PUT,DELETE,OPTIONS');

    const response = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: siteOrigin } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], siteOrigin);
  } finally {
    await app.close();
  }
});

test('does not grant CORS access to an unlisted origin', async () => {
  const app = buildApp(fakeDb, fakeStore);
  await app.ready();
  try {
    const response = await app.inject({ method: 'OPTIONS', url: '/healthz', headers: { origin: 'https://example.com' } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  } finally {
    await app.close();
  }
});
