# Render API + PostgreSQL with a Mac mini worker

This is the production shape for the current project:

```text
Clip Validator Site -> Render API -> Render PostgreSQL
                         ^              ^
                         |              |
                    shared R2      Mac mini worker
```

The API and worker share PostgreSQL for the durable queue and R2 for source, render, caption, thumbnail, and brand assets. The Mac mini makes outbound connections only; it does not need a public worker URL.

## 1. Render PostgreSQL

Create a Render PostgreSQL database in the same region as the API. Use the Render internal connection string for the API service. Keep the external connection string for the Mac mini and any one-time migration commands. The external URL must use TLS (`sslmode=require`).

For a new empty deployment, run the migrations against the Render database from a trusted machine:

```sh
DATABASE_URL='RENDER_EXTERNAL_DATABASE_URL' pnpm db:migrate
```

The current Docker images do not include the root `db/` migration runner, so run this from the checkout for now. The database is the system of record; Render service disks are not used for persistent assets.

If you are moving the existing local Clip Validator data, use a full dump into the new empty Render database instead of running migrations first:

```sh
pg_dump --format=custom --no-owner --no-privileges \
  --host=127.0.0.1 --port=5433 --username=clipper --dbname=clipper \
  --file=clipper-local.dump
pg_restore --no-owner --no-privileges \
  --dbname='RENDER_EXTERNAL_DATABASE_URL' clipper-local.dump
```

Keep `clipper-local.dump` private and delete it only after confirming the hosted database. If the hosted database already has the schema, stop and choose a data-only restore or a fresh empty database; do not blindly restore over a live database.

## 2. Render API service

Create a Docker Web Service from the private `axios-clip-validator` repository:

- Dockerfile path: `apps/api/Dockerfile`
- Root directory/context: repository root
- Region: same as PostgreSQL
- Health check path: `/healthz`
- Port: Render supplies `PORT`; the API listens on it
- Instance: use a paid instance for an always-on shared app; free instances sleep

Set these environment variables on the API:

```text
ASSET_STORE=r2
DATABASE_URL=RENDER_INTERNAL_DATABASE_URL
R2_ENDPOINT=https://6d95407ee5e890968497e5a42412af7b.r2.cloudflarestorage.com
R2_BUCKET=axios-clip-assets
R2_REGION=auto
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
MAX_UPLOAD_BYTES=5000000000
```

Do not put the R2 keys in the frontend site or GitHub. The site only needs the public API URL, such as `https://axios-clip-api.onrender.com`.

## 3. Mac mini worker

On the Mac mini:

```sh
git clone git@github.com:calebkelson/axios-clip-validator.git
cd axios-clip-validator
cp mac-worker.env.example .env.mac-worker
```

Edit `.env.mac-worker` with the Render external database URL and the R2 access key pair. Then start the worker container:

```sh
docker compose -f docker-compose.mac-worker.yml up --build -d
docker compose -f docker-compose.mac-worker.yml logs -f worker
```

The worker image supplies FFmpeg, ffprobe, yt-dlp, the Axios logo, the licensed font, and a writable temporary directory. It downloads one R2 source to scratch storage for probing/transcription/rendering, then uploads the generated assets back to R2. It does not expose a port.

To stop processing without losing queued work:

```sh
docker compose -f docker-compose.mac-worker.yml stop
```

Queued jobs remain in PostgreSQL and resume when the worker comes back.

## 4. Move existing local assets

After the hosted database contains the existing `assets` rows and the R2 credentials are configured, run a dry run from the machine containing the current `data/` directory:

```sh
DATABASE_URL='RENDER_EXTERNAL_DATABASE_URL' \
ASSET_DATA_DIR=./data \
R2_ENDPOINT='https://6d95407ee5e890968497e5a42412af7b.r2.cloudflarestorage.com' \
R2_BUCKET=axios-clip-assets \
R2_ACCESS_KEY_ID='...' \
R2_SECRET_ACCESS_KEY='...' \
pnpm assets:migrate-r2
```

Review the missing-file report. Add `--apply` only when the report is clean. The migration overwrites the same R2 keys if rerun, updates `public_reference`, and never deletes local files.
