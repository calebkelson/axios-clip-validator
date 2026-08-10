import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import pg from 'pg';
import { LocalAssetStore, R2AssetStore } from '@clipper/storage';

const apply = process.argv.includes('--apply');
const env = process.env;
const required = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;
for (const name of required) if (!env[name]) throw new Error(`${name} is required`);

const db = new pg.Pool({ connectionString: env.DATABASE_URL });
const local = new LocalAssetStore(env.ASSET_DATA_DIR ?? './data');
const r2 = new R2AssetStore({
  endpoint: env.R2_ENDPOINT!,
  bucket: env.R2_BUCKET!,
  region: env.R2_REGION ?? 'auto',
  accessKeyId: env.R2_ACCESS_KEY_ID!,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
});

const rows = await db.query('SELECT id, storage_key, byte_size FROM assets ORDER BY created_at, storage_key');
let uploaded = 0;
let missing = 0;
let failed = 0;

console.log(`${apply ? 'Uploading' : 'Dry run:'} ${rows.rowCount ?? 0} asset row(s) from ${env.ASSET_DATA_DIR ?? './data'} to R2 bucket ${env.R2_BUCKET}`);
if (!apply) console.log('Pass --apply to upload and update public_reference; local files are never deleted.');

for (const row of rows.rows) {
  const key = row.storage_key as string;
  const path = local.getPath(key);
  try {
    const file = await stat(path);
    if (!apply) {
      console.log(`would upload ${key} (${file.size} bytes)`);
      continue;
    }
    const result = await r2.putStream(key, createReadStream(path));
    await db.query('UPDATE assets SET byte_size=$2, public_reference=$3 WHERE id=$1', [row.id, result.byteSize, r2.getPublicReference(key)]);
    uploaded += 1;
  } catch (error) {
    if (isMissingFile(error)) {
      missing += 1;
      console.error(`missing local asset: ${key}`);
    } else {
      failed += 1;
      console.error(`failed ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

await db.end();
console.log(JSON.stringify({ apply, total: rows.rowCount ?? 0, uploaded, missing, failed }, null, 2));
if (missing || failed) process.exitCode = 1;

function isMissingFile(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
