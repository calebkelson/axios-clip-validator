FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/storage/package.json packages/storage/package.json
RUN pnpm install --frozen-lockfile=false
COPY apps/api apps/api
COPY packages/contracts packages/contracts
COPY packages/storage packages/storage
RUN pnpm build
RUN mkdir -p /data
ENV ASSET_DATA_DIR=/data
CMD ["pnpm", "--filter", "@clipper/api", "start"]
