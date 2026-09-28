# Running it by hand

What a person can exercise today, what they cannot, and the exact commands —
with the responses to expect, so that "it works" is checkable rather than
asserted.

Everything in **Verified** below was run on 2026-09-28 against a throwaway
PostgreSQL and the real `main.js`. The outputs are transcribed, not predicted.
Everything in **Not yet reachable** is honestly out of reach and says why.

---

## Preconditions

A database, and nothing else for the API. Either:

```sh
docker compose --profile infra up -d     # postgres, redis, blnk, mock-oauth2
```

or any PostgreSQL you can reach — the service needs no extension and no
superuser beyond what a migration needs.

With a **remote** Docker daemon, published ports appear on the daemon's host.
Set `BAAS_HOST` in `.env` and read `localhost` below as that address.

---

## 1. Seed — required, and nothing starts without it

Both processes refuse to start without a `tenant` row matching
`BOOTSTRAP_TENANT_SLUG`. That is deliberate (New-18): a service that invents
its own tenant on boot will eventually invent one in production.

```sh
cp .env.example .env
pnpm seed                        # or: docker compose run --rm seed
```

Expect:

```
{"applied":9,"msg":"migrations applied"}
{"tenantSlug":"superchat","msg":"tenant ready"}

  An API client was created. This secret is shown once.

    X-SC-CLIENT-ID:     bff
    X-SC-CLIENT-SECRET: <43 characters>

  Scopes: mobile:accounts, mobile:transactions
```

**Note the secret down.** Only its hash is stored. Running the seed again does
not reveal it and deliberately does not rotate it — a seed that reset a
credential on re-run would reset it for whoever was using the old one. To mint
a new one, delete the `api_client` row and seed again.

The command refuses any tier but `dev`, before touching the database.

---

## 2. The API

```sh
pnpm start:api
```

Expect `{"port":3000,"tenantSlug":"superchat","msg":"api listening"}`.

### Verified

| Request                                                 | Response                                                  |
| ------------------------------------------------------- | --------------------------------------------------------- |
| `GET /system/health`                                    | `200` `{"status":"ok"}`                                   |
| `GET /system/ready`                                     | `{"ready":true,"checks":{"database":true,"schema":true}}` |
| `GET /platform/system` — no session                     | `401`                                                     |
| `GET /mobile/accounts` — no credential                  | `401`                                                     |
| `GET /mobile/accounts` — wrong secret                   | `401`                                                     |
| `GET /mobile/accounts` — **seeded** client              | `401 "user identity is required on this route"`           |
| `POST /webhooks/keel` — unsigned                        | `202`                                                     |
| `OPTIONS /platform/system` from `http://localhost:5173` | `204` + `Access-Control-Allow-Origin`                     |
| `OPTIONS /platform/system` from another origin          | no allow-origin header                                    |

The sixth row is the one that matters. Reaching _"user identity is required"_
means the client credential was **accepted** — seed, bcrypt hash, repository
and guard all agree. A wrong secret stops one guard earlier, and both answer
`401`, which is the point: they are indistinguishable to a caller.

`POST /webhooks/keel` answering `202` unsigned is also correct. Every delivery
is answered `202` and recorded; look at `provider_inbox.signature_verified`,
never at the status code.

### Readiness is the probe worth watching

`/system/health` says the process is up. `/system/ready` asserts the **schema
matches the declaration**, so a half-applied migration fails it (finding C1).
Point a health check at `/system/ready`.

---

## 3. The portal

```sh
cp apps/portal/.env.example apps/portal/.env
pnpm portal:dev                  # http://localhost:5173
```

Click **Sign in** → the mock provider's form accepts anything → type a subject
listed in `OPERATOR_BOOTSTRAP_ADMIN_SUBJECTS` (`first-operator` by default) →
you land on the **System** panel: schema state, migration count, outbox
unresolved, inbox backlog, rejected signatures.

**A subject that is not on that list signs in successfully and can reach
nothing.** Registration deliberately grants no role (MP-1, finding C3). That
is not a bug.

### Three settings must agree

| Setting                              | Must be                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `VITE_OIDC_ISSUER` and `OIDC_ISSUER` | **byte-identical**, and the address the _browser_ uses                       |
| `OIDC_JWKS_URI`                      | the address the _service_ uses — `http://oidc:8080/baas/jwks` inside compose |
| `CORS_ORIGINS`                       | the portal's origin; a wildcard is not an option                             |

The issuer is a **string compared** against the token's `iss`; the JWKS URI is
a **URL fetched**. In compose they genuinely differ. Getting the issuer wrong
produces a `401` that explains nothing — deliberately, because telling a caller
why a token was refused tells them how to make a better one — which makes the
first sign-in in a new environment the one most likely to fail opaquely. Check
these three before debugging anything else.

### What was verified, and what was not

Verified on 2026-09-28: the dev server serves, the bundle builds, and the API
accepts and refuses the portal's origin correctly.

**Not verified: the sign-in round trip against a real provider.** It needs
`mock-oauth2-server`, which needs a Docker daemon. Both halves are covered by
tests — `operator-signin.test.ts` for the service, 39 portal tests for the
browser — but the seam between them, with a real provider in the middle, has
not been exercised by a person. **It is the first thing to try, and the first
thing to suspect.**

---

## Not yet reachable

|                                            | Why                                                                                           | Task   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | ------ |
| Mobile reads (`/mobile/*`)                 | Need an ES256 assertion the BFF would mint; nothing here mints one                            | New-25 |
| Real balances, live provider calls         | No provider credentials configured; `/system/capabilities` reports `not_configured`, honestly | —      |
| Verified partner callbacks                 | Need `PROVIDER_<NAME>_WEBHOOK_PUBLIC_KEY` or `_CALLBACK_HMAC_SECRET`                          | —      |
| Customer, accounts and transaction screens | Not built, and the seed creates no customers                                                  | MP-7b  |
| The portal in Docker                       | No image and no compose service                                                               | New-23 |

The mobile gap is the sharpest one: M1-5, M1-8 and M1-9 are reachable only from
the automated tests, which is the shape of finding N1 — a path that works in a
test and has never been exercised by a person.
