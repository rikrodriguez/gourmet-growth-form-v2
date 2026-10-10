# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY vite.office.config.ts tsconfig.json ./
COPY office ./office
COPY src ./src
RUN npm run office:build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    OFFICE_RUNTIME_MODE=staging \
    OFFICE_STAGING_ROLE=viewer
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --from=build --chown=node:node /app/dist-office ./dist-office
COPY --chown=node:node src/office ./src/office
COPY --chown=node:node src/operations ./src/operations
COPY --chown=node:node migrations/office ./migrations/office
COPY --chown=node:node scripts/office-staging-health.mjs ./scripts/office-staging-health.mjs
USER node
EXPOSE 4180
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 \
    CMD ["node", "scripts/office-staging-health.mjs"]
CMD ["node", "--import", "tsx", "src/office/backend/staging-server.ts"]
