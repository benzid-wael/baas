# baas

Superchat banking platform, second generation. Design lives in
`superchat-platform/RFCs/BaaS/` — `rfc-baas-architecture.md` for the design,
`breakdown.md` for the plan of record, `rollout.md` for what ships when,
`adapter-lift-inventory.md` for what can be carried over from the incumbent.

## Requirements

- Node 24 (see `.nvmrc`)
- pnpm 9

## Commands

| Command                   | What it does                                         |
| ------------------------- | ---------------------------------------------------- |
| `pnpm verify`             | Every local gate, in the order CI runs them          |
| `pnpm format` / `:check`  | Prettier                                             |
| `pnpm lint`               | ESLint, type-checked on source, syntactic on tooling |
| `pnpm typecheck`          | `tsc --build` across the project references          |
| `pnpm check:boundaries`   | Layer direction, declared imports, domain purity     |
| `pnpm check:config`       | Validate an environment against its tier contract    |
| `pnpm check:openapi`      | Fail if `openapi.json` is stale or breaks a client   |
| `pnpm openapi:generate`   | Rewrite `openapi.json` from the contract registry    |
| `pnpm test` / `:coverage` | Vitest; coverage thresholds at 70%                   |
| `pnpm sim`                | Run the partner simulator on `PORT` (default 4010)   |

## Layout

```
packages/
  domain/         framework-free core. Zero runtime dependencies, enforced.
  platform/       infrastructure seams: clock, ids, config, logging, errors.
  contracts/      wire schemas -> types, validation, OpenAPI.
  persistence/    migrations, Kysely, outbox, inbox, idempotency.
apps/
  api/            HTTP transport and the guard chain.
  worker/         dispatcher, reconciler, scheduler.
  provider-sim/   partner sandbox simulator. Development and CI only.
  e2e/            system tests that wire several apps. No production code.
```

Everything else in the RFC's layout arrives with its task. The workspace is
built one package at a time, and each arrives with its gate already passing.

## Docker

The daemon is **not assumed to be local** — `DOCKER_HOST` may point at a
devserver. See [`docs/docker.md`](docs/docker.md). Two loops:

```sh
docker compose --profile infra up -d          # postgres, redis, blnk, sim
docker compose --profile full  up -d --build  # the above plus api and worker
```

The fast loop runs backing services in containers and `api`/`worker` directly
on your machine. No source is bind-mounted, because a bind mount resolves on
the daemon's filesystem rather than yours.

## Tests

There is no way to run the suite without a database, and that is deliberate.
`startDatabase()` downloads and runs **real** PostgreSQL with no daemon, no
socket and no Docker, so `pnpm test` works on a laptop that has never
installed it. No persistence test is skippable: the incumbent has 521 skipped
tests and that is the layer where its real defects lived.

None of this needs Docker — see above; the suite starts its own PostgreSQL.
Set `DATABASE_URL` to use a containerised one instead.

`apps/e2e/src/spine.test.ts` is the one to read first. It asserts the whole
spine in one test — enqueue, dispatch, a signed webhook, a row in
`provider_inbox`, reconciliation to `confirmed` — with no partner sandbox and
no operator.

## Two things a deployment must get right

Both are silent when wrong, and neither is visible in a single-tenant
environment.

1. **Do not connect as a superuser.** A superuser bypasses row-level security
   entirely, even under `FORCE ROW LEVEL SECURITY`. The policies would be in
   place and tenant isolation would not exist.
2. **Set `app.tenant_id` transaction-locally**, with `set_config(..., true)`
   inside a transaction. The session-scoped form survives a pooled connection
   being returned, so the next request inherits the previous tenant.

## Boundaries

Every package declares its layer in its own `package.json`:

```json
{ "baas": { "layer": "domain" } }
```

`pnpm check:boundaries` enforces four rules:

1. **Every package declares a layer.** A package the gate cannot classify is a
   package it cannot check, so an undeclared layer fails rather than passing.
2. **Dependencies point inward.** A package may import a strictly lower layer
   only. `domain` (0) → `contracts`, `platform` (1) → `app` (9). Equal ranks
   may not import each other, which is what keeps infrastructure out of the
   contracts the mobile client is generated from.
3. **Every bare import is declared by the importing package**, in
   `dependencies` for source and `devDependencies` for tests. This is the rule
   resolution cannot provide: pnpm isolates transitive dependencies, but Node
   resolution walks up the tree, so anything installed at the workspace root
   is importable everywhere. The root therefore holds only the toolchain, and
   this rule is what keeps that true.
4. **The domain imports nothing**, and environment-neutral layers (`domain`,
   `contracts`) import no Node built-in, so the generated client runs in React
   Native. A build tool inside such a package declares itself in
   `baas.toolFiles` and is exempt.

## Contracts

One zod schema per concept in `packages/contracts`. From it come the
TypeScript type, HTTP validation and the OpenAPI document; the mobile client
will follow. A schema reaches the published document by being registered in
`contracts.ts` and by nothing else, so the surface is a list someone can read.

`openapi.json` is committed and byte-compared. `pnpm check:openapi` fails when
it is stale, and fails harder when the change would break a client:

- **structural** — a path, operation, response, property or schema disappears;
  a type changes
- **contractual** — a property's required-ness changes, in either direction
- **value-level** — an enum gains or loses a member; a `pattern` or `format`
  changes; a length or numeric bound tightens

Both directions are reported because a component schema is referenced from
request and response positions alike, and they break oppositely: adding an enum
member breaks a consumer switching exhaustively, removing one breaks a producer
still sending it. Each finding names which risk it is.

A deliberate break is declared by bumping `OPENAPI_VERSION` in
`packages/contracts/src/contracts.ts`. The gate then says the break was
intended and passes.

## Configuration

`APP_ENV` is the deployment tier — `dev`, `stage` or `production` — and drives
every hardening rule. It is deliberately **not** `NODE_ENV`, which the image
pins to `production` and so cannot distinguish environments. An unset `APP_ENV`
on a production image resolves to `production`, so an omission can only make a
deployment stricter.

Copy `.env.example` to `.env` to start locally. Every secret in it is a
placeholder that stage and production refuse, so the file cannot be promoted by
accident. `pnpm check:config` validates a manifest against its tier and reports
**every** violated rule at once.
