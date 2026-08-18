import pg from 'pg';
import { createAssetStore } from '@clipper/storage';
import { buildApp } from './app.js';

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? 4),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 5_000),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30_000),
  query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS ?? 10_000),
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 10_000),
});
const store = createAssetStore();
const app = buildApp(db, store, Number(process.env.MAX_UPLOAD_BYTES ?? 5_000_000_000));
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
