FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core python3 python3-venv && rm -rf /var/lib/apt/lists/* && python3 -m venv /opt/yt-dlp && /opt/yt-dlp/bin/pip install --no-cache-dir yt-dlp
COPY package.json pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/processing/package.json packages/processing/package.json
COPY packages/storage/package.json packages/storage/package.json
RUN pnpm install --frozen-lockfile=false
COPY apps/worker apps/worker
COPY packages/processing packages/processing
COPY packages/storage packages/storage
COPY assets assets
RUN pnpm build && mkdir -p /tmp/clipper /data && chmod 777 /tmp/clipper /data
ENV TMPDIR=/tmp/clipper
ENV BRAND_LOGO_PATH=/app/assets/brand/axios-logo.png
ENV BRAND_FONT_PATH=/app/assets/brand/NBInternationalPro-Bold.ttf
ENV BRAND_FONT_NAME="NB International Pro Bold"
ENV SOURCE_PLATFORM_ADAPTER=yt-dlp
ENV YTDLP_BIN=/opt/yt-dlp/bin/yt-dlp
CMD ["pnpm", "--filter", "@clipper/worker", "start"]
