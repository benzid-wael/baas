import { SetMetadata } from "@nestjs/common";

/**
 * Every route declares its policy. A route that declares none is refused by
 * `AuthorizationPolicyGuard` — deny by default, structurally.
 *
 * The incumbent's `RolesGuard` returns true when a route declares no `@Roles`,
 * which is fail-open; the backstop below is what makes silence a refusal
 * rather than a permission.
 */
export const SCOPES_KEY = "baas:scopes";
export const ROLES_KEY = "baas:roles";
export const MOBILE_SURFACE_KEY = "baas:mobile-surface";
export const PUBLIC_KEY = "baas:public";

/** Required API-client scopes. Declaring `@Scopes()` with none is a policy. */
export const Scopes = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes);

export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Marks a route as reachable by a forwarded end-user identity.
 *
 * This is the confused-deputy control: a signed user assertion is only
 * honoured on a route that says it expects one, so a stolen assertion cannot
 * be replayed against an operator or platform route.
 */
export const MobileSurface = () => SetMetadata(MOBILE_SURFACE_KEY, true);

/** Unauthenticated by explicit declaration, never by omission. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const OPERATOR_SURFACE_KEY = "baas:operator-surface";

/**
 * Marks a route as reachable by a signed-in operator.
 *
 * The counterpart to `@MobileSurface()`, and deliberately mutually exclusive
 * with it. These are different trust boundaries: a mobile route carries a
 * customer identity forwarded by the BFF and may only ever touch that
 * customer's data, while an operator route carries a staff session and reads
 * any customer in the tenant. A route that claimed both would be a route
 * where the stronger authority silently applies.
 */
export const OperatorSurface = () => SetMetadata(OPERATOR_SURFACE_KEY, true);

/** The approver role, which `admin` deliberately does not satisfy (D1). */
export const ROLE_APPROVER = "approver";
export const ROLE_ADMIN = "admin";
