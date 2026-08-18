# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# Manifests first so the dependency layers survive source-only changes.
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/jellyfin/package.json packages/jellyfin/

# Full install, then build the SPA.
FROM manifests AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @jfstats/web build

# Production dependencies only — no Vite, no Playwright, no testcontainers.
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

FROM base AS runtime
ENV NODE_ENV=production WEB_ROOT=/app/web
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps /app/packages/jellyfin/node_modules ./packages/jellyfin/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY apps/server ./apps/server
COPY packages ./packages
COPY --from=build /app/apps/web/dist ./web
USER node
EXPOSE 3000
# tsx is a dependency of the workspace root package.json (not any individual
# app), so its bin lands at one stable path — node_modules/.bin/tsx — instead
# of moving whenever workspace packages' dependency lists change.
CMD ["node_modules/.bin/tsx", "apps/server/src/api.ts"]
