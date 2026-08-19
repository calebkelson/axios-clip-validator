import pg from 'pg';
import { MediaProcessor, RenderProcessor, ThumbnailProcessor } from '@clipper/processing';
import { createAssetStore } from '@clipper/storage';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = createAssetStore();
const mediaWorker = new MediaProcessor(db, store, Number(process.env.LEASE_SECONDS ?? 60));
const renderWorker = new RenderProcessor(db, store, Number(process.env.RENDER_LEASE_SECONDS ?? process.env.LEASE_SECONDS ?? 60));
const thumbnailWorker = new ThumbnailProcessor(db, store, Number(process.env.THUMBNAIL_LEASE_SECONDS ?? process.env.LEASE_SECONDS ?? 120));
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 1);
if (concurrency !== 1) console.warn('Worker currently runs one leased media, render, or thumbnail job at a time');

let running = false;
const tick = async () => {
  if (running) return;
  running = true;
  try {
    const mediaJob = await mediaWorker.runOnce();
    if (!mediaJob) {
      const thumbnailJob = await thumbnailWorker.runOnce();
      if (!thumbnailJob) await renderWorker.runOnce();
    }
  } finally {
    running = false;
  }
};

setInterval(() => void tick().catch(console.error), 1000);
void tick().catch(console.error);
