# Treno server image — one image, commands per role (PLAN_docker_clickhouse.md §1):
#   collector: npx tsx packages/collector/src/index.ts
#   api:       npx tsx packages/api/src/server.ts       (port 8787)
#   trainer:   node bin/train-loop.mjs                  (nightly 03:30 Rome loop)
#
# node:24 for built-in node:sqlite + zlib zstd; tsx runs TS directly, no build step.
FROM node:24-slim

WORKDIR /app

# dependency layer: workspace manifests only, then full install (tsx/typescript are devDeps)
COPY package.json package-lock.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY packages/gtfs/package.json packages/gtfs/
COPY packages/providers/package.json packages/providers/
COPY packages/storage/package.json packages/storage/
COPY packages/collector/package.json packages/collector/
COPY packages/api/package.json packages/api/
RUN npm ci --no-audit --no-fund

COPY packages ./packages
COPY bin ./bin
COPY apps/web ./apps/web

ENV TRENO_DATA_DIR=/data
RUN mkdir -p /data
VOLUME /data
EXPOSE 8787

# slim has no curl/wget — probe the API health route with node's built-in fetch.
# (Roles that don't serve HTTP disable this in docker-compose.yml.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "packages/collector/src/index.ts"]
