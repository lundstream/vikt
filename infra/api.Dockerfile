# Build context is the repo root.
# Pinned by digest (D138). The tag still reads as the version it is; the
# digest is what actually gets pulled, here and on the build runner.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ------------------------------------------------------------------ deps
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ----------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter api build

# --------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production

# `pg_dump`, for the scheduled backup the app runs itself (D103).
#
# D96 shipped a shell script that called `docker compose exec postgres pg_dump`,
# which the API container cannot do: it has no docker socket and should never
# have one. So the dump is taken over the ordinary Postgres connection, and the
# client has to be in this image. Version 16 to match the server, because
# pg_dump refuses a server newer than itself and that is a failure that only
# ever shows up during a restore.
# From PGDG, not Debian. Bookworm ships PostgreSQL 15 and has no
# `postgresql-client-16` at all, so this layer failed the first time anything
# actually built the image: it had been written, documented as done, and never
# run. Debian's own `postgresql-client` would install version 15, which then
# refuses a 16 server, and that is the same failure one step later and only
# visible during a restore.
RUN apt-get update \
 && apt-get install --no-install-recommends -y ca-certificates curl gnupg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install --no-install-recommends -y postgresql-client-16 \
 && apt-get purge -y curl gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
# `shared` is bundled into dist by tsup, so only the api's own runtime deps
# are installed here.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter api...

COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/drizzle apps/api/drizzle
COPY infra/api-entrypoint.sh /usr/local/bin/api-entrypoint.sh
RUN chmod +x /usr/local/bin/api-entrypoint.sh

WORKDIR /app/apps/api
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/api-entrypoint.sh"]
CMD ["node", "dist/index.js"]
