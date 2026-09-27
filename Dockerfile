# Two entrypoints from one image (RFC-BaaS §3.3): `api` and `worker` are the
# same build with different commands, so a worker deploy cannot possibly be
# running different code from the API it shares a database with.
#
# No source is mounted at runtime. The Docker daemon may be remote — a bind
# mount would resolve on the daemon's filesystem, not the developer's — so
# everything the image needs is copied in at build time.

FROM node:24-bookworm-slim AS build
WORKDIR /srv

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Manifests first, so a dependency install is cached across source edits.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/domain/package.json       packages/domain/
COPY packages/platform/package.json     packages/platform/
COPY packages/contracts/package.json    packages/contracts/
COPY packages/persistence/package.json  packages/persistence/
COPY packages/provider-keel/package.json packages/provider-keel/
COPY packages/provider-ruya/package.json packages/provider-ruya/
COPY packages/application/package.json  packages/application/
COPY apps/api/package.json              apps/api/
COPY apps/worker/package.json           apps/worker/
COPY apps/provider-sim/package.json     apps/provider-sim/
COPY apps/e2e/package.json              apps/e2e/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
RUN pnpm run typecheck

# Both entrypoints must exist (New-18). Asserted here rather than discovered at
# `docker compose up`, which is how the `full` profile came to reference two
# files that were never built.
RUN test -f apps/api/dist/main.js && test -f apps/worker/dist/main.js

# A second install, production-only, so the runtime image carries no
# toolchain and no test harness — notably not the PostgreSQL binaries that
# `embedded-postgres` pulls in as a devDependency of @baas/persistence.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:24-bookworm-slim AS runtime
WORKDIR /srv

ENV NODE_ENV=production
# NODE_ENV is pinned here and is therefore useless for distinguishing
# environments. APP_ENV carries the tier; see RFC-BaaS §5.5.

RUN groupadd --system baas && useradd --system --gid baas --home /srv baas

COPY --from=build --chown=baas:baas /srv/node_modules           ./node_modules
COPY --from=build --chown=baas:baas /srv/packages               ./packages
COPY --from=build --chown=baas:baas /srv/apps                   ./apps
COPY --from=build --chown=baas:baas /srv/package.json           ./

USER baas
EXPOSE 3000

# Overridden per service in compose. There is no default that starts
# something: a container that guesses which process it is is a container that
# eventually guesses wrong.
CMD ["node", "--version"]
