import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const apiUrl = process.env.CLIPPER_API_URL?.trim().replace(/\/$/, '') ?? '';
const channelId = process.env.YOUTUBE_CHANNEL_ID?.trim() ?? '';
const retentionCsv = process.env.YOUTUBE_RETENTION_CSV?.trim() ?? '';
const intervalHours = Math.max(1, Number(process.env.INSIGHTS_INTERVAL_HOURS ?? 24) || 24);
const runOnStart = process.env.INSIGHTS_RUN_ON_START !== 'false';
const retentionEnabled = process.env.YOUTUBE_RETENTION_IMPORT_ENABLED !== 'false';
const forceRetentionImport = process.env.YOUTUBE_RETENTION_FORCE === 'true';
const ingestLimit = Math.max(0, Number(process.env.YOUTUBE_INGEST_LIMIT ?? 5) || 5);
const ingestMode = process.env.YOUTUBE_INGEST_MODE ?? 'find_moments';
const lockName = 'axios-clipper.youtube-insights-daily';

const db = new pg.Pool({ connectionString: databaseUrl });
let running = false;

type JobSummary = {
  startedAt: string;
  automation?: unknown;
  retention?: unknown;
  warnings: string[];
  errors: string[];
};

async function runAutomation() {
  if (!apiUrl || !channelId) {
    return { skipped: true, reason: 'CLIPPER_API_URL or YOUTUBE_CHANNEL_ID is not configured' };
  }
  const response = await fetch(`${apiUrl}/v1/youtube/automation/run`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ channelId, limit: ingestLimit, mode: ingestMode, fullScan: false, dryRun: false }),
  });
  const body = await response.text();
  let parsed: unknown = body;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Keep the response text when the API does not return JSON.
  }
  if (!response.ok) throw new Error(`YouTube automation returned HTTP ${response.status}: ${JSON.stringify(parsed)}`);
  return parsed;
}

async function runRetentionImport() {
  if (!retentionEnabled) return { skipped: true, reason: 'YOUTUBE_RETENTION_IMPORT_ENABLED=false' };
  if (!retentionCsv) return { skipped: true, reason: 'YOUTUBE_RETENTION_CSV is not configured' };
  try {
    await stat(retentionCsv);
  } catch {
    return { skipped: true, reason: `retention CSV not found: ${retentionCsv}` };
  }

  const args = ['db:import-retention'];
  if (forceRetentionImport) args.push('--', '--force');
  return await new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, { env: process.env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      if (code === 0) resolve({ exitCode: 0, output });
      else reject(new Error(`Retention import exited with code ${code ?? 'unknown'}${output ? `: ${output}` : ''}`));
    });
  });
}

async function runOnce() {
  if (running) {
    console.warn('Insights run already in progress; skipping this tick.');
    return;
  }
  running = true;
  const summary: JobSummary = { startedAt: new Date().toISOString(), warnings: [], errors: [] };
  let client: pg.PoolClient | undefined;
  try {
    client = await db.connect();
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockName]);
    if (!lock.rows[0]?.locked) {
      console.warn('Another insights scheduler holds the database lock; skipping this tick.');
      return;
    }
    try {
      try {
        summary.automation = await runAutomation();
        if ((summary.automation as { skipped?: boolean })?.skipped) summary.warnings.push((summary.automation as { reason: string }).reason);
      } catch (error) {
        summary.errors.push(`YouTube automation: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        summary.retention = await runRetentionImport();
        if ((summary.retention as { skipped?: boolean })?.skipped) summary.warnings.push((summary.retention as { reason: string }).reason);
      } catch (error) {
        summary.errors.push(`Retention import: ${error instanceof Error ? error.message : String(error)}`);
      }
      console.log(JSON.stringify({ ...summary, finishedAt: new Date().toISOString() }, null, 2));
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
    }
  } finally {
    client?.release();
    running = false;
  }
}

const tick = () => void runOnce().catch((error) => console.error('Insights scheduler tick failed:', error));
console.log(`YouTube insights scheduler started; interval=${intervalHours}h, runOnStart=${runOnStart}`);
if (runOnStart) tick();
setInterval(tick, intervalHours * 60 * 60 * 1000);

const shutdown = async () => {
  await db.end();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
