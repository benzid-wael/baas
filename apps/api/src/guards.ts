import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import bcrypt from "bcrypt";
import type { Logger } from "@baas/platform";
import { describeError } from "@baas/platform";
import {
  MOBILE_SURFACE_KEY,
  OPERATOR_SURFACE_KEY,
  PUBLIC_KEY,
  ROLES_KEY,
  ROLE_ADMIN,
  ROLE_APPROVER,
  SCOPES_KEY,
} from "./decorators.js";
import { PRINCIPAL_KEY, header } from "./principal.js";
import type { Principal, RequestWithPrincipal } from "./principal.js";
import { verifyAssertion } from "./assertion.js";
import type { AssertionConfig } from "./assertion.js";

export interface ApiClientRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly secretHash: string;
  readonly disabled: boolean;
  readonly scopes: readonly string[];
  readonly roles: readonly string[];
}

export interface ApiClientLookup {
  byClientId(clientId: string): Promise<ApiClientRecord | undefined>;
}

export interface CustomerLookup {
  byExternalUuid(
    tenantId: string,
    externalUserUuid: string,
  ): Promise<{ customerId: string } | undefined>;
}

/**
 * A hash of a secret that matches nothing, compared against when the client is
 * unknown so that an unknown client and a wrong secret take the same time.
 * Carried over from the incumbent, where it was one of the controls that read
 * as deliberate.
 */
const DUMMY_HASH =
  "$2b$10$CwTycUXWue0Thq9StjUM0uJ8.pmPGb/JFS0bkfWCXBMeYJk3VmRLa";

/** 1 — authenticate the caller and resolve its tenant from the credential. */
@Injectable()
export class ApiClientGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly clients: ApiClientLookup,
    private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(
        PUBLIC_KEY,
        targets,
      ) === true
    ) {
      return true;
    }
    // An operator route is authenticated by a session, not a client
    // credential: the portal runs in a browser and cannot hold a secret.
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(
        OPERATOR_SURFACE_KEY,
        targets,
      ) === true
    ) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const clientId = header(request, "x-sc-client-id");
    const secret = header(request, "x-sc-client-secret");

    if (clientId === undefined || secret === undefined) {
      throw new UnauthorizedException("client credentials are required");
    }

    const record = await this.clients.byClientId(clientId);
    // Compare regardless, so an unknown client and a wrong secret are
    // indistinguishable by timing.
    const matches = await bcrypt.compare(
      secret,
      record?.secretHash ?? DUMMY_HASH,
    );

    if (record === undefined || !matches || record.disabled) {
      this.logger.warn(
        { apiClientId: clientId },
        "api client authentication failed",
      );
      throw new UnauthorizedException("invalid client credentials");
    }

    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required !== undefined) {
      const missing = required.filter(
        (scope) => !record.scopes.includes(scope),
      );
      if (missing.length > 0) {
        throw new ForbiddenException(`missing scope: ${missing.join(", ")}`);
      }
    }

    // The tenant comes from the credential, never from a header or body the
    // caller controls (RFC-BaaS §4).
    request[PRINCIPAL_KEY] = {
      tenantId: record.tenantId,
      apiClientId: record.id,
      scopes: record.scopes,
      roles: record.roles,
    };
    return true;
  }
}

/**
 * 2 — resolve a forwarded end-user identity, **only** on a route that declares
 * `@MobileSurface()`.
 *
 * This is the confused-deputy control. A stolen assertion cannot be replayed
 * against an operator or platform route, because those routes do not look at
 * one.
 */
@Injectable()
export class UserUuidResolverGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly customers: CustomerLookup,
    private readonly assertion: AssertionConfig,
    private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isMobile = this.reflector.getAllAndOverride<boolean | undefined>(
      MOBILE_SURFACE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isMobile !== true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = request[PRINCIPAL_KEY];
    if (principal === undefined) {
      throw new UnauthorizedException(
        "client authentication must precede identity",
      );
    }

    const uuid = header(request, "x-sc-user-uuid");
    const token = header(request, "x-sc-user-assertion");
    if (uuid === undefined || token === undefined) {
      throw new UnauthorizedException(
        "user identity is required on this route",
      );
    }

    try {
      const verified = verifyAssertion(token, this.assertion);
      if (verified.subject !== uuid) {
        throw new UnauthorizedException(
          "assertion subject does not match the user",
        );
      }
      const customer = await this.customers.byExternalUuid(
        principal.tenantId,
        uuid,
      );
      if (customer === undefined) {
        throw new UnauthorizedException("no customer for this identity");
      }
      request[PRINCIPAL_KEY] = {
        ...principal,
        customerId: customer.customerId,
        externalUserUuid: uuid,
        roles: [...principal.roles, "customer"],
      };
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.warn(
        { err: describeError(error) },
        "user assertion rejected",
      );
      throw new UnauthorizedException("invalid user assertion");
    }
  }
}

/**
 * 3 — a principal must exist by now, unless the route is explicitly public.
 *
 * This guard is where "authenticated" stops being an assumption. It reads the
 * public flag through the Reflector like every other guard: an earlier draft
 * read it off the handler object directly, which silently never matched and
 * turned every public route into a 403.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic =
      this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;
    if (isPublic) {
      return true;
    }
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    if (request[PRINCIPAL_KEY] === undefined) {
      throw new UnauthorizedException("authentication is required");
    }
    return true;
  }
}

/**
 * 4 — roles.
 *
 * Finding D1: the incumbent's `roles.guard.ts` short-circuits on the admin
 * role, so separation of duties rests entirely on user-id comparisons inside
 * each service. Here `admin` is a role like any other, and **`approver` is a
 * role admin does not satisfy** — which makes dual control structural rather
 * than conventional.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const roles = request[PRINCIPAL_KEY]?.roles ?? [];

    const satisfied = required.some((role) => {
      if (roles.includes(role)) {
        return true;
      }
      // Admin implies the ordinary operator roles, and never `approver`.
      return (
        role !== ROLE_APPROVER &&
        roles.includes(ROLE_ADMIN) &&
        role !== "customer"
      );
    });

    if (!satisfied) {
      throw new ForbiddenException(`requires role: ${required.join(" or ")}`);
    }
    return true;
  }
}

/**
 * 5 — the backstop. A route that declares no policy at all is refused.
 *
 * This is the structural fix for the incumbent's fail-open default: silence
 * becomes a refusal rather than a permission, so forgetting to annotate a new
 * controller cannot expose it.
 */
@Injectable()
export class AuthorizationPolicyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly logger: Logger,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const declared =
      this.reflector.getAllAndOverride<boolean | undefined>(
        PUBLIC_KEY,
        targets,
      ) === true ||
      this.reflector.getAllAndOverride<string[] | undefined>(
        SCOPES_KEY,
        targets,
      ) !== undefined ||
      this.reflector.getAllAndOverride<string[] | undefined>(
        ROLES_KEY,
        targets,
      ) !== undefined ||
      // "A signed-in operator, whatever their role" is a policy. Without this
      // the backstop refuses sign-out, which no role can sensibly gate — and
      // the alternative, listing every role on it, states the rule worse.
      this.reflector.getAllAndOverride<boolean | undefined>(
        OPERATOR_SURFACE_KEY,
        targets,
      ) === true;

    if (!declared) {
      const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
      this.logger.error(
        {
          route: request.url ?? "unknown",
          method: request.method ?? "unknown",
        },
        "route declares no authorization policy and was refused",
      );
      throw new ForbiddenException("route declares no authorization policy");
    }
    return true;
  }
}

export type { Principal };
