import pg from 'pg';
import { LocalAssetStore } from '@clipper/storage';
import { buildApp } from './app.js';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = new LocalAssetStore(process.env.ASSET_DATA_DIR ?? '/data');
const app = buildApp(db, store, Number(process.env.MAX_UPLOAD_BYTES ?? 5_000_000_000));
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
