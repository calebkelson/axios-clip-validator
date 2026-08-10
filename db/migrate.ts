import { readFile, readdir } from 'node:fs/promises'; import { join } from 'node:path'; import pg from 'pg';
const validate = process.argv.includes('--validate'); const dir = new URL('./migrations/', import.meta.url);
const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort(); if (!files.length) throw new Error('No migrations found');
for (const f of files) { const sql = await readFile(join(dir.pathname, f), 'utf8'); if (!/(CREATE TABLE|ALTER TABLE|CREATE INDEX)/i.test(sql)) throw new Error(`Migration ${f} contains no schema change`); }
if (validate) { console.log(`${files.length} migration(s) validated`); process.exit(0); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect(); await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
for (const file of files) { if ((await client.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [file])).rowCount) continue; await client.query('BEGIN'); try { await client.query(await readFile(join(dir.pathname, file), 'utf8')); await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [file]); await client.query('COMMIT'); console.log(`Applied ${file}`); } catch (e) { await client.query('ROLLBACK'); throw e; } } await client.end();
