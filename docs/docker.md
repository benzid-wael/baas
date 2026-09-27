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
pnpm start:api        # builds, then runs apps/api/dist/main.js
pnpm start:worker     # builds, then runs apps/worker/dist/main.js
```

Both processes refuse to start without a `tenant` row matching
`BOOTSTRAP_TENANT_SLUG`. That is not a convenience check: a service that cannot
resolve its tenant cannot scope a single query, and starting anyway would mean
every request discovers the problem separately.

The **API** applies migrations at boot when `DATABASE_MIGRATIONS_RUN=true`. The
**worker** never does — two processes racing the same migration on a deploy is
a lock-contention bug that only shows up under load — so start the API first,
or at least once, before the worker has anything to read.

### Full loop — everything in Docker

What CI and a pre-deploy smoke run do.

```sh
docker compose --profile full up -d --build
curl http://$BAAS_HOST:3000/system/health
curl http://$BAAS_HOST:3000/system/ready
```

`/system/ready` is the one worth reading. It asserts the **schema**, not the
migration ledger: it reports ready only when the tables are the tables the
code declares, so a half-applied migration fails it (finding C1).

`/system/capabilities` says which providers are on and why. With `PROVIDERS=`
unset there are none, and that is reported rather than hidden. Set
`PROVIDERS=keel,ruya` and fill in the `PROVIDER_*` keys from `.env.example` to
get live adapters; a provider named there with a required setting missing
reports `not_configured` in dev and **refuses to boot** in stage and
production.

Four reasons, and they mean different things to different people:

| Reason                      | What it means                              |
| --------------------------- | ------------------------------------------ |
| `adapter_absent`            | this build cannot construct that provider  |
| `not_configured`            | it can, and a setting is missing           |
| `disabled_by_configuration` | turned off deliberately                    |
| `operation_not_implemented` | the adapter supplies no port for that call |

The first two are the pair worth keeping apart: one is a job for whoever holds
the credentials, the other for whoever ships the code.

### The provider request log

Every provider call — request, response, status, duration, outcome — is written
to `provider_request_log`, and an operator reads it at
`GET /platform/provider-requests`. It is the thing that makes a failed call
explicable, and it is also the **most sensitive table in the service**. Three
rules follow, and all three are enforced rather than advised:

- **Bodies are scrubbed on the way in**, by the same named shapes as the log
  scrubber. A reduction of risk, not an elimination of it.
- **Rows expire.** Every row carries the time it must be gone by (30 days by
  default), and the worker purges them on its ordinary schedule. A deployment
  running the API without the worker accumulates provider bodies forever — that
  is the single worst state this service can be in.
- **Reads are audited**, and the list view omits the bodies. Fetching one call
  by id is a separate act with its own audit row.

`operation` records the **route**, not the concrete path: BaNCS and Keel both
put account references in the path, and a list of fifty of those is fifty
account references on an operator's screen.

### Partner callbacks

`POST /webhooks/:provider` is mounted and verifies signatures. Both schemes are
the partners' own, reproduced by `provider-sim`, so a delivery the simulator
signs is a delivery a partner could have sent:

| Provider | Header                      | Scheme                                                                                         |
| -------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| Keel     | `X-Digital-Signature`       | base64 RSA-SHA256 over the raw body, verified with `PROVIDER_KEEL_WEBHOOK_PUBLIC_KEY`          |
| Ruya     | `X-Ruya-Callback-Signature` | `sha256=<hex>` or bare hex HMAC-SHA256 over the raw body, `PROVIDER_RUYA_CALLBACK_HMAC_SECRET` |

Four behaviours worth knowing before you debug one:

- **Everything gets a 202**, including a bad signature. A partner that retries
  on a non-2xx would retry a bad signature forever, and telling it the
  signature was wrong tells an attacker the same thing. **Look at
  `provider_inbox.signature_verified`, not at the status code.**
- **A rejected delivery is still recorded.** Rejected traffic is the evidence
  that someone is probing, and it is what distinguishes a misconfigured partner
  from a silent one.
- **Missing credential means everything is rejected, not accepted.** There is
  no setting that turns verification off.
- **A provider this deployment holds no credentials for is answered 202 and
  recorded nowhere.** Telling a caller which provider ids exist is free
  reconnaissance.
- **A body that is not valid JSON is recorded too**, as
  `{"unparseable": "<the bytes>"}`, and answered 202 like everything else. The
  response says nothing about the body — the JSON parser's own message quotes
  the input back, and an unverified caller must not get a fragment of its
  request reflected.

The signature is over the **exact bytes** the partner sent, which is why the
application is created with `rawBody: true`. Anything in front of it that
re-serialises a body — a proxy that pretty-prints JSON, say — breaks every
delivery, and does so only where a real partner exists.

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

| Variable        | Default | Service            |
| --------------- | ------- | ------------------ |
| `POSTGRES_PORT` | 5432    | postgres           |
| `REDIS_PORT`    | 6379    | redis              |
| `BLNK_PORT`     | 5001    | blnk               |
| `OIDC_PORT`     | 8090    | mock-oauth2-server |
| `SIM_PORT`      | 4010    | provider-sim       |
| `API_PORT`      | 3000    | api                |

## Operator sign-in locally

`mock-oauth2-server` runs in the `infra` profile and needs no configuration.
Any username and password is accepted; the tokens it issues are real, signed,
and served from a real JWKS endpoint, which is what the verifier actually
exercises.

Two settings that look redundant and are not:

```
OIDC_ISSUER=http://localhost:8090/baas     # a string, compared against `iss`
OIDC_JWKS_URI=http://oidc:8080/baas/jwks   # a URL, fetched by the service
```

The token's `iss` is whatever address the **browser** used. The JWKS URI is
whatever address the **service** can reach. In compose those are different —
a published port versus a container name — and collapsing them into one
setting makes local sign-in impossible to configure without lying about one of
the two. When `api` runs on your machine instead, point the JWKS URI at
`localhost:8090` as well.

Grant yourself `admin` by putting your subject in
`OPERATOR_BOOTSTRAP_ADMIN_SUBJECTS`. Seed **two** — dual control needs two
people, and the incumbent deadlocked three separate workflows because an
environment had one administrator.

## What is deliberately not here

**`provider-sim` must never be deployed.** It signs webhooks with a key it can
generate itself and serves whatever routes it is given, so anywhere reachable
from a deployed environment it is an unauthenticated provider-event injector.
It appears in this compose file and must not appear in a deployment manifest.

**No `latest` tags on backing services.** `postgres:16-alpine`,
`redis:7-alpine` and a pinned Blnk. A floating tag means the version you
develop against changes without a commit.
