# Stage 1: Build
FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
# Cache bust: 2026-03-14 — force fresh pnpm install to pick up Prisma v7 + @prisma/adapter-pg
ARG CACHE_BUST=2026-03-16
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# pnpm build runs: prisma generate && nest build
RUN pnpm build

# Stage 2: Runtime
FROM node:20-alpine
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/public ./public
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
RUN addgroup --system --gid 1001 engram && adduser --system --uid 1001 --ingroup engram engram
RUN chown -R engram:engram /app
RUN apk add --no-cache curl
USER engram
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -f http://localhost:3001/v1/health || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
