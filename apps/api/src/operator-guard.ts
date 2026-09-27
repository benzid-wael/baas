import { Injectable, UnauthorizedException } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Kysely } from "kysely";
import type { Database, OperatorRepository } from "@baas/persistence";
import type { Logger } from "@baas/platform";
import { MOBILE_SURFACE_KEY, OPERATOR_SURFACE_KEY } from "./decorators.js";
import { PRINCIPAL_KEY, header } from "./principal.js";
import type { RequestWithPrincipal } from "./principal.js";

/**
 * Establishes an operator principal from a session (MP-1).
 *
 * Runs only on `@OperatorSurface()` routes, and **refuses a route that also
 * claims `@MobileSurface()`**. Those are different trust boundaries — one
 * carries a customer identity forwarded by the BFF and may touch only that
 * customer, the other carries a staff session and reads any customer in the
 * tenant. A route claiming both is a route where the stronger authority
 * silently applies, so it is a configuration error rather than a preference.
 */
@Injectable()
export class OperatorSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: Kysely<Database>,
    private readonly operators: OperatorRepository,
    private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isOperator =
      this.reflector.getAllAndOverride<boolean | undefined>(
        OPERATOR_SURFACE_KEY,
        targets,
      ) === true;
    if (!isOperator) {
      return true;
    }

    const isMobile =
      this.reflector.getAllAndOverride<boolean | undefined>(
        MOBILE_SURFACE_KEY,
        targets,
      ) === true;
    if (isMobile) {
      throw new MixedSurfaceError();
    }

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const token = bearer(request);
    if (token === undefined) {
      throw new UnauthorizedException("an operator session is required");
    }

    // Resolved outside a tenant scope, like an API client: looking the session
    // up is how the tenant is discovered.
    const session = await this.operators.resolveSession(this.db, token);
    if (session === undefined) {
      this.logger.warn(
        { route: request.url ?? "unknown" },
        "operator session rejected",
      );
      throw new UnauthorizedException("an operator session is required");
    }

    request[PRINCIPAL_KEY] = {
      tenantId: session.tenantId,
      // An operator is not an API client. Naming the session here rather than
      // borrowing an api client id keeps the audit honest about who acted.
      apiClientId: `operator:${session.operatorId}`,
      scopes: [],
      roles: session.roles,
      operatorId: session.operatorId,
    };

    // Fire and forget: a failed touch must not fail the request, and the
    // value of last_seen_at is not worth a second round trip on the hot path.
    void this.operators
      .touch(this.db, session.sessionId)
      .catch((error: unknown) => {
        this.logger.debug(
          { err: error instanceof Error ? error : new Error("unknown") },
          "could not record operator session activity",
        );
      });

    return true;
  }
}

export class MixedSurfaceError extends Error {
  readonly code = "api.route.mixed_surface";
  constructor() {
    super(
      "A route may declare @MobileSurface or @OperatorSurface, not both: they are different trust boundaries",
    );
    this.name = "MixedSurfaceError";
  }
}

function bearer(request: RequestWithPrincipal): string | undefined {
  const value = header(request, "authorization");
  if (value === undefined) {
    return undefined;
  }
  const match = /^Bearer (.+)$/.exec(value);
  return match?.[1];
}
