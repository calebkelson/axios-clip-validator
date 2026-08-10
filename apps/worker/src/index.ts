import pg from 'pg';
import { MediaProcessor, RenderProcessor } from '@clipper/processing';
import { LocalAssetStore } from '@clipper/storage';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = new LocalAssetStore(process.env.ASSET_DATA_DIR ?? '/data');
const mediaWorker = new MediaProcessor(db, store, Number(process.env.LEASE_SECONDS ?? 60));
const renderWorker = new RenderProcessor(db, store, Number(process.env.RENDER_LEASE_SECONDS ?? process.env.LEASE_SECONDS ?? 60));
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 1);
if (concurrency !== 1) console.warn('Phase 4 worker currently runs one leased media or render job at a time');

let running = false;
const tick = async () => {
  if (running) return;
  running = true;
  try {
    const mediaJob = await mediaWorker.runOnce();
    if (!mediaJob) await renderWorker.runOnce();
  } finally {
    running = false;
  }
};

setInterval(() => void tick().catch(console.error), 1000);
void tick().catch(console.error);
