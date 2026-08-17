import { readFile } from 'node:fs/promises';

const filePath = process.argv[2] ?? process.env.TREND_SNAPSHOT_FILE;
const apiUrl = process.env.TREND_API_URL?.trim();
const token = process.env.TRENDS_INGEST_TOKEN?.trim();

if (!filePath) throw new Error('Pass a trend snapshot JSON path or set TREND_SNAPSHOT_FILE.');
if (!apiUrl) throw new Error('Set TREND_API_URL to the hosted API base URL.');
if (!token) throw new Error('Set TRENDS_INGEST_TOKEN for authenticated publishing.');

const raw = await readFile(filePath, 'utf8');
const payload = JSON.parse(raw) as Record<string, unknown>;
const response = await fetch(new URL('/v1/trending/snapshots', apiUrl), {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(payload),
});

const body = await response.text();
if (!response.ok) throw new Error(`Trend publish failed (${response.status}): ${body}`);
console.log(body);
