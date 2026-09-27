# Running with Docker

The Docker daemon is **not assumed to be on your machine**. `DOCKER_HOST` may
point at a devserver, and two things follow from that:

- **No source is bind-mounted.** A bind mount resolves on the daemon's
  filesystem, so mounting `./packages` would mount whatever is at that path on
  the devserver — usually nothing. Application services build an image, and
  editing code means rebuilding that service.
- **Nothing assumes `localhost`.** Published ports appear on the daemon's
  host. `BAAS_HOST` below is where _you_ reach them.

## The two loops

### Fast loop — infra in Docker, processes on your machine

The usual one. Backing services in containers, `api` and `worker` running
directly so a change is visible without a rebuild.

```sh
docker compose --profile infra up -d
```

Then point your local processes at the daemon's host. With a **local** daemon
nothing needs setting. With a **remote** daemon, put its address in `.env`:

```sh
# .env — only needed when DOCKER_HOST is not local
DATABASE_HOST=devserver.internal
REDIS_URL=redis://devserver.internal:6379
```

Then:

```sh
pnpm check:config     # validates the manifest before anything starts
node apps/api/dist/main.js
node apps/worker/dist/main.js
```

### Full loop — everything in Docker

What CI and a pre-deploy smoke run do.

```sh
docker compose --profile full up -d --build
curl http://$BAAS_HOST:3000/system/health
```

## The tests need none of this

`pnpm test` starts its own real PostgreSQL, in-process, with no daemon. That
is deliberate: a harness that needs a running daemon is a harness that gets
skipped, and the incumbent has 521 skipped tests for exactly that reason. You
can run the whole suite on a laptop with Docker uninstalled.

To run the suite against a containerised database instead — to reproduce
something environment-specific — set `DATABASE_URL` and it will use that
server rather than starting one.

## Ports

Every published port is overridable, because a devserver is usually shared and
5432 is usually taken.

| Variable        | Default | Service      |
| --------------- | ------- | ------------ |
| `POSTGRES_PORT` | 5432    | postgres     |
| `REDIS_PORT`    | 6379    | redis        |
| `BLNK_PORT`     | 5001    | blnk         |
| `SIM_PORT`      | 4010    | provider-sim |
| `API_PORT`      | 3000    | api          |

## What is deliberately not here

**`provider-sim` must never be deployed.** It signs webhooks with a key it can
generate itself and serves whatever routes it is given, so anywhere reachable
from a deployed environment it is an unauthenticated provider-event injector.
It appears in this compose file and must not appear in a deployment manifest.

**No `latest` tags on backing services.** `postgres:16-alpine`,
`redis:7-alpine` and a pinned Blnk. A floating tag means the version you
develop against changes without a commit.
