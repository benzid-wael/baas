import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import { formatInstant } from "@baas/platform";
import type { Logger } from "@baas/platform";
import { describeError } from "@baas/platform";
import type {
  Database,
  OperatorRepository,
  TenantScope,
} from "@baas/persistence";
import { ROLE_ADMIN } from "@baas/persistence";
import { OperatorSurface, Public } from "./decorators.js";
import { OidcError } from "./oidc.js";
import type { OidcVerifier } from "./oidc.js";
import { principalOf } from "./principal.js";
import type { RequestWithPrincipal } from "./principal.js";

export const OPERATOR_SESSIONS = "baas:OperatorSessions";

export interface OperatorSessionDeps {
  readonly verifier: OidcVerifier;
  readonly operators: OperatorRepository;
  readonly scope: TenantScope;
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  /** The tenant an operator signs in to. One tenant today; see RFC §4. */
  readonly tenantId: string;
  /**
   * Subjects granted `admin` on first sign-in, once. Registration grants no
   * role, so without this a fresh environment has nobody who can grant one.
   */
  readonly bootstrapAdminSubjects: readonly string[];
}

export interface SignInRequest {
  readonly idToken?: unknown;
}

/**
 * Exchanging an identity-provider token for a session (MP-1).
 *
 * The portal performs the authorization-code flow with PKCE against the
 * identity provider itself and posts the resulting ID token here. `baas` never
 * holds a client secret and never proxies the provider — it verifies a token
 * and issues a session of its own.
 */
@Controller("operator")
export class OperatorSessionController {
  constructor(
    @Inject(OPERATOR_SESSIONS) private readonly deps: OperatorSessionDeps,
  ) {}

  @Post("sessions")
  @Public()
  @HttpCode(201)
  async signIn(
    @Body() body: SignInRequest,
  ): Promise<{ token: string; expiresAt: string }> {
    if (typeof body.idToken !== "string" || body.idToken === "") {
      throw new BadRequestException("idToken is required");
    }

    let identity;
    try {
      identity = await this.deps.verifier.verify(body.idToken);
    } catch (error) {
      // The reason stays in the log. Telling a caller *why* a token was
      // refused tells them how to make a better one.
      this.deps.logger.warn(
        { err: describeError(error) },
        "operator sign-in rejected",
      );
      throw new UnauthorizedException(
        error instanceof OidcError && error.code === "oidc.misconfigured"
          ? "operator sign-in is not configured"
          : "could not verify that identity",
      );
    }

    const tenantId = this.deps.tenantId;
    const operator = await this.deps.scope.run(tenantId, (db) =>
      this.deps.operators.upsert(db, tenantId, identity),
    );

    if (operator.disabled) {
      throw new UnauthorizedException("could not verify that identity");
    }

    await this.bootstrapIfConfigured(tenantId, operator.id, identity.subject);

    const session = await this.deps.scope.run(tenantId, (db) =>
      this.deps.operators.issueSession(db, tenantId, operator.id),
    );

    return {
      token: session.token,
      expiresAt: formatInstant(session.expiresAt),
    };
  }

  @Delete("sessions/current")
  @OperatorSurface()
  @HttpCode(204)
  async signOut(@Req() request: RequestWithPrincipal): Promise<void> {
    const operatorId = principalOf(request)?.operatorId;
    /* c8 ignore next 3 -- the guard has already refused a request without one */
    if (operatorId === undefined) {
      return;
    }
    // Every session, not just this one. Someone signing out of a console that
    // reads any customer usually means it, and "log me out everywhere" is
    // never the wrong interpretation of that.
    await this.deps.scope.run(this.deps.tenantId, (db) =>
      this.deps.operators.revokeAllFor(db, operatorId),
    );
  }

  /**
   * Grant `admin` to a configured subject, once.
   *
   * Idempotent, and audited by the grant itself carrying its reason. Anyone
   * who can edit the manifest could already change the JWKS URI, so this adds
   * no authority they did not have — but it does make the grant **visible**,
   * which a quiet database insert would not.
   */
  private async bootstrapIfConfigured(
    tenantId: string,
    operatorId: string,
    subject: string,
  ): Promise<void> {
    if (!this.deps.bootstrapAdminSubjects.includes(subject)) {
      return;
    }
    await this.deps.scope.run(tenantId, (db) =>
      this.deps.operators.grantRole(db, tenantId, {
        operatorId,
        role: ROLE_ADMIN,
        grantedBy: null,
        reason: "bootstrap from configuration",
      }),
    );
    this.deps.logger.warn(
      { operatorId },
      "granted admin from the bootstrap configuration",
    );
  }
}
