import pg from 'pg';
import { createAssetStore } from '../packages/storage/dist/index.js';
import { PlaybackPreviewGenerator } from '../packages/processing/dist/index.js';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = createAssetStore();
const generator = new PlaybackPreviewGenerator(db, store);
const sourceIdArg = valueAfter('--source-id');
const limitArg = Number(valueAfter('--limit') ?? 0);
const rows = await db.query(`
  SELECT ms.id, source_asset.storage_key
  FROM media_sources ms
  JOIN LATERAL (
    SELECT storage_key FROM assets WHERE source_id=ms.id AND role='source' ORDER BY created_at DESC LIMIT 1
  ) source_asset ON true
  WHERE ms.media_type='video'
    AND NOT EXISTS (SELECT 1 FROM assets WHERE source_id=ms.id AND role='preview')
    AND ($1::uuid IS NULL OR ms.id=$1)
  ORDER BY ms.created_at, ms.id
`, [sourceIdArg ?? null]);

let generated = 0;
let skipped = 0;
let failed = 0;
const failures: Array<{ sourceId: string; error: string }> = [];
const selected = limitArg > 0 ? rows.rows.slice(0, limitArg) : rows.rows;
console.log(JSON.stringify({ event: 'playback_preview_backfill_started', eligible: rows.rowCount ?? 0, selected: selected.length }));
for (const row of selected) {
  try {
    const result = await generator.ensure(row.id as string, row.storage_key as string, process.env.TMPDIR ?? '/tmp/clipper-preview-backfill');
    if (result.status === 'generated') generated += 1;
    else skipped += 1;
    console.log(JSON.stringify({ event: 'playback_preview_backfill_item', sourceId: row.id, status: result.status, assetId: result.assetId }));
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message : 'preview generation failed';
    failures.push({ sourceId: row.id as string, error: message });
    console.warn(JSON.stringify({ event: 'playback_preview_backfill_failed', sourceId: row.id, error: message }));
  }
}
console.log(JSON.stringify({ event: 'playback_preview_backfill_complete', generated, skipped, failed, failures }));
await db.end();

function valueAfter(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
