import bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import type { Clock, IdGenerator } from "@baas/domain";
import { toJsDate } from "@baas/platform";
import { TenantScope } from "@baas/persistence";
import type { Database } from "@baas/persistence";

/**
 * Make an empty database into one the service can start against (New-24).
 *
 * Both processes refuse to start without a `tenant` row, deliberately: a
 * service that invents its own tenant on boot will eventually invent one in
 * production. That decision needs a *path*, and this is it — explicit, run by
 * a person, and refused outside dev.
 *
 * **It mints a credential.** That is the whole reason it is not a migration
 * and not something the API does at boot. A secret that appears without anyone
 * asking is a secret nobody knows exists, and the first place it turns up is a
 * production environment that was "just brought up the same way".
 */
export class SeedRefusedError extends Error {
  readonly code = "seed.refused";

  constructor(appEnv: string) {
    super(
      `Refusing to seed a "${appEnv}" environment. This mints an API client secret and grants it scopes; outside dev those are decisions someone signs off, not a command someone runs.`,
    );
    this.name = "SeedRefusedError";
  }
}

export interface SeedRequest {
  readonly appEnv: string;
  readonly tenantSlug: string;
  readonly tenantName: string;
  /** The client the BFF presents. Omitted means tenant only. */
  readonly clientId?: string;
  readonly scopes?: readonly string[];
}

export interface SeedResult {
  readonly tenantId: string;
  readonly created: boolean;
  /**
   * Printed once and never stored in plaintext. A second run of the seed
   * against an existing client does not reveal the old secret — it has only
   * the hash, which is the point.
   */
  readonly clientSecret?: string;
}

export async function seed(
  db: Kysely<Database>,
  clock: Clock,
  ids: IdGenerator,
  request: SeedRequest,
): Promise<SeedResult> {
  if (request.appEnv !== "dev") {
    throw new SeedRefusedError(request.appEnv);
  }

  const now = toJsDate(clock.now());

  const existing = await db
    .selectFrom("tenant")
    .select("id")
    .where("slug", "=", request.tenantSlug)
    .executeTakeFirst();

  const tenantId = existing?.id ?? ids.next();
  if (existing === undefined) {
    await db
      .insertInto("tenant")
      .values({
        id: tenantId,
        slug: request.tenantSlug,
        name: request.tenantName,
        created_at: now,
      })
      .execute();
  }

  if (request.clientId === undefined) {
    return { tenantId, created: existing === undefined };
  }

  const client = await db
    .selectFrom("api_client")
    .select("id")
    .where("client_id", "=", request.clientId)
    .executeTakeFirst();

  if (client !== undefined) {
    // Idempotent, and deliberately does not rotate. Re-running the seed to
    // recover a lost secret would make "run it again" a credential-reset
    // command, which is not what anybody thinks they are doing.
    return { tenantId, created: false };
  }

  // 32 bytes from the CSPRNG. Long enough that it is never guessed and
  // awkward enough that nobody is tempted to reuse it anywhere real.
  const clientSecret = randomBytes(32).toString("base64url");
  const apiClientId = ids.next();

  await db
    .insertInto("api_client")
    .values({
      id: apiClientId,
      tenant_id: tenantId,
      client_id: request.clientId,
      secret_hash: await bcrypt.hash(clientSecret, 10),
      name: request.clientId,
      disabled_at: null,
      created_at: now,
    })
    .execute();

  // Through `runAsScopeAdmin`, the same door an operator's grant goes through
  // (MP-3). A seed that could write this table directly would be a second way
  // in, and the trigger exists precisely so there is only one.
  const scope = new TenantScope(db);
  for (const granted of request.scopes ?? []) {
    await scope.runAsScopeAdmin(tenantId, (trx) =>
      trx
        .insertInto("api_client_scope")
        .values({
          id: ids.next(),
          api_client_id: apiClientId,
          scope: granted,
          granted_at: now,
          granted_by: tenantId,
          revoked_at: null,
          revoked_by: null,
          reason: "seeded for local development",
        })
        .execute(),
    );
  }

  return { tenantId, created: true, clientSecret };
}
