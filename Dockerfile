FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.1 --activate
COPY package.json pnpm-lock.yaml tsconfig.json ./
# --prod=false so a build-time NODE_ENV=production (Coolify default) cannot
# prune devDependencies (typescript, etc.) needed for `pnpm build`.
RUN pnpm install --frozen-lockfile --prod=false
COPY src ./src
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.1 --activate
# curl is required for Coolify/container healthchecks (GET /health).
RUN apk add --no-cache curl
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder --chown=node:node /app/dist ./dist
USER node
EXPOSE 3007
# start.js binds $PORT (defaults to 3001) and boots the queue worker.
# app.js only exports the Express app and never listens — do not use it as CMD.
CMD ["node", "dist/server/start.js"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3001}/health || exit 1
