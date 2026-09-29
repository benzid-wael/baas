# Running it by hand

What a person can exercise today, what they cannot, and the exact commands —
with the responses to expect, so that "it works" is checkable rather than
asserted.

Everything in **Verified** below was run against a throwaway PostgreSQL and the
real `main.js`, and the outputs are transcribed rather than predicted.
Everything in **Not yet reachable** is honestly out of reach and says why.

Two things this document will not do: claim something works because a test
covers it, or leave a gap unstated. Where a seam has only ever been crossed by
a test, it says so.

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

## 3. The mobile surface, by hand

The customer read surface needs an ES256 assertion the BFF would normally mint.
There is no BFF here, so two dev-only commands stand in. Both refuse any tier
but `dev`, before touching anything.

```sh
pnpm seed:demo      # as above, plus a demo customer with three accounts
pnpm assertion      # prints a key pair and a 60-second assertion
```

`pnpm assertion` generates a throwaway key pair and prints the public half in
the single-line base64 form `MOBILE_ASSERTION_PUBLIC_KEY` wants. Put it in
`.env`, restart the API, then export the private half to mint more against the
same key:

```sh
export DEV_ASSERTION_PRIVATE_KEY=<the single line it printed>
pnpm assertion
```

Then, with the client credentials from `pnpm seed`:

```sh
curl -H "x-sc-client-id: bff"       -H "x-sc-client-secret: $SECRET" \
     -H "x-sc-user-uuid: $UUID"     -H "x-sc-user-assertion: $ASSERTION" \
     http://localhost:3000/mobile/accounts
```

### Verified

| Request                                               | Response                   |
| ----------------------------------------------------- | -------------------------- |
| `GET /mobile/accounts`                                | `200`, three accounts      |
| `GET /mobile/accounts/DEMO-ACCT-OLD`                  | `200`, balance with an age |
| `GET /mobile/accounts/DEMO-ACCT-OLD/transactions`     | `200 {"items":[]}`         |
| `GET /mobile/accounts/SOMEONE-ELSE`                   | `404` — not `403`          |
| tampered assertion                                    | `401`                      |
| assertion whose subject ≠ the `x-sc-user-uuid` header | `401`                      |

The last two are the confused-deputy control working: a stolen assertion is no
use with a different uuid, and the `404` on an account that is not theirs is
the same answer as one that does not exist.

### The three balance shapes

The demo customer exists so that a screen cannot be built against one shape.
Finding F4 is an absent value rendered as a confident `0.00`, which reads as
"you have no money" and is a worse lie than an error.

| Account            | Balance                                                           |
| ------------------ | ----------------------------------------------------------------- |
| `DEMO-ACCT-RECENT` | observed seconds ago — `fresh: true` for 30 seconds after seeding |
| `DEMO-ACCT-OLD`    | observed an hour ago — `observed`, `fresh: false`, with an age    |
| `DEMO-ACCT-SILENT` | `{"kind":"unavailable","reason":"never_observed"}`                |

**`RECENT` reports `fresh: false` more than 30 seconds after seeding**, because
with no provider adapter nothing can refresh it. That is the honest behaviour
rather than a bug; seed and look immediately to see `fresh: true`.

## 4. The portal

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

### What the console can do

Four screens, and **System is where you land** — it reads the API the moment
the session exists, so a session that cannot reach the service says so on
arrival. The other three call nothing until you ask them to.

| Screen                | What it answers                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **System**            | each provider available or **why not**, in a sentence naming who should look at it; effects awaiting an outcome; inbox backlog; callbacks that failed their signature; schema drift with the offending columns |
| **Customers**         | find one by exact identifier, see their accounts with honest balances, page their transactions                                                                                                                 |
| **Provider requests** | every call to a provider, filterable by **account reference**, correlation id or provider; open one for the scrubbed bodies                                                                                    |
| **API clients**       | every client and its scope history; grant a scope with a reason, revoke a live grant. Admin only — a non-admin sees the history and disabled controls that say why                                             |

Things worth trying, because each is a decision you may disagree with:

- Search the demo customer (`0192f3a4-5b6c-7d8e-8f90-000000000001`) and look at
  **DEMO-ACCT-SILENT** — it shows "Not available" and **no figure at all**.
  Finding F4: an absent balance rendered as `0.00` reads as "you have no
  money", which is a worse lie than an error.
- **DEMO-ACCT-OLD** shows its age in words — "as of an hour ago" — rather than
  presenting an old figure as current.
- The customer screen states that **every lookup is recorded against your
  name**, including ones that find nothing. An audit trail the audited do not
  know about is a trap rather than a control.
- On **API clients**, sign in as a subject with no admin role: the grant
  control is disabled and says _why_, rather than being offered and then
  refused with a 403. That is finding F1, and it is the rule for every control
  on the screen.
- Leave the console open past its eight-hour session and it warns you in the
  last hour rather than lapsing silently mid-form. Roles, though, are read
  **once at sign-in** — revoke somebody's admin role and their open console
  keeps offering the control until they sign in again. The API refuses it; the
  screen is the thing that is wrong (New-28).
- There is **no way to reach a customer by URL**. The back button does not work
  inside the console; that is the trade, and it means a link pasted into a chat
  carries nothing.

### What was verified, and what was not

Verified on 2026-09-28, by running it: the dev server serves, the bundle
builds, the API accepts the portal's origin and refuses others, and the three
`/platform` endpoints the screens call return what the screens expect —
checked against the published schemas.

**Not verified: the sign-in round trip against a real provider.** It needs
`mock-oauth2-server`, which needs a Docker daemon. Both halves are covered by
tests — `operator-signin.test.ts` for the service, 100 portal tests for the
browser — but the seam between them, with a real provider in the middle, has
not been exercised by a person. **It is the first thing to try, and the first
thing to suspect.**

---

## 5. Not yet reachable

|                                                    | Why                                                                                                                       | Task   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------ |
| Real balances, live provider calls                 | No provider credentials configured. `/system/capabilities` reports `not_configured` rather than hiding it                 | —      |
| Verified partner callbacks                         | Need `PROVIDER_<NAME>_WEBHOOK_PUBLIC_KEY` or `_CALLBACK_HMAC_SECRET`. Unsigned deliveries are still recorded, as rejected | —      |
| The portal **in Docker**                           | The image and compose service exist and **have never been built** — the daemon was never used                             | New-23 |
| Anything that **writes** — payments, beneficiaries | Not built. Everything above is a read                                                                                     | M2, M3 |

The read surface is now exercisable by a person end to end: seed, sign in,
find a customer, see honest balances, trace a provider call. That was the shape
of finding N1 — a path that works in a test and has never been run by anybody —
and it no longer applies to reads.

**What is still only exercised by tests** is the writing spine: the outbox
dispatches, the reconciler settles, and `spine.test.ts` proves it end to end
with a simulated partner — but no person has watched money move, because
nothing here moves money yet.
