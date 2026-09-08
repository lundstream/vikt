# Build context is the repo root.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter web...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# The build leaves __APP_NAME__ in place on purpose; 30-app-name.sh fills it in
# when the container starts, so a rename needs no rebuild (DECISIONS.md D13).
RUN pnpm --filter web build

# --------------------------------------------------------------- runtime
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
# Both substitution scripts run from nginx's own entrypoint directory, in name
# order: the app name first, then the deployment modes (D13, D94).
COPY infra/nginx/31-modes.sh /docker-entrypoint.d/31-modes.sh
COPY infra/nginx/30-app-name.sh /docker-entrypoint.d/30-app-name.sh
COPY infra/nginx/32-site-config.sh /docker-entrypoint.d/32-site-config.sh
RUN chmod +x /docker-entrypoint.d/30-app-name.sh /docker-entrypoint.d/31-modes.sh \
             /docker-entrypoint.d/32-site-config.sh
EXPOSE 80
