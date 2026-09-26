/**
 * Who is making this request.
 *
 * Built by the guard chain and never by a controller. The mobile end user
 * lives on the `customer` registry via `externalUserUuid`, not on a `users`
 * table — `users` is login-only, and getting that wrong is the Model B
 * correction the incumbent had to make.
 */
export interface Principal {
  readonly tenantId: string;
  readonly apiClientId: string;
  readonly scopes: readonly string[];
  readonly roles: readonly string[];
  /** Present only on a mobile-surface route, resolved from a signed assertion. */
  readonly customerId?: string;
  readonly externalUserUuid?: string;
}

export const PRINCIPAL_KEY = "baasPrincipal";

export interface RequestWithPrincipal {
  [PRINCIPAL_KEY]?: Principal;
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
}

export function principalOf(
  request: RequestWithPrincipal,
): Principal | undefined {
  return request[PRINCIPAL_KEY];
}

export function header(
  request: RequestWithPrincipal,
  name: string,
): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
