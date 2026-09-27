import type { INestApplication } from "@nestjs/common";
import type { ContractRegistry } from "@baas/contracts";

/**
 * Routes and the contract registry must agree (New-12).
 *
 * This is the cost of choosing a registry over `@nestjs/swagger` decorators
 * in T7. The decorator approach derives the document from the routes, so the
 * two cannot disagree; the registry approach buys a reviewable, bootless,
 * byte-diffable document and gives that guarantee up.
 *
 * Both failure modes are silent, and the second is worse:
 *
 * - an endpoint exists and is undocumented — the contract understates the
 *   surface, and nobody knows the route is there;
 * - a path is documented and does not exist — a client is written against it.
 *
 * So both are reported. Reading the route table needs no listening server, so
 * this runs as an ordinary test.
 */
export interface RouteMismatch {
  readonly mountedButUnregistered: readonly string[];
  readonly registeredButUnmounted: readonly string[];
}

interface RouteLayer {
  route?: { path?: string; methods?: Record<string, boolean> };
}

interface ExpressLikeRouter {
  stack?: RouteLayer[];
}

/**
 * Enumerate what Nest actually mounted.
 *
 * Reaches into the Express router because Nest exposes no public route table.
 * Narrow and defensive: if the internals move, this returns nothing and the
 * comparison fails loudly rather than passing by accident.
 */
export function mountedRoutes(app: INestApplication): readonly string[] {
  const server = app.getHttpAdapter().getInstance() as {
    router?: ExpressLikeRouter;
    _router?: ExpressLikeRouter;
  };
  const router = server.router ?? server._router;
  const stack = router?.stack ?? [];

  const found: string[] = [];
  for (const layer of stack) {
    const path = layer.route?.path;
    const methods = layer.route?.methods ?? {};
    if (path === undefined) {
      continue;
    }
    for (const [method, enabled] of Object.entries(methods)) {
      if (enabled) {
        found.push(`${method.toUpperCase()} ${normalise(path)}`);
      }
    }
  }
  return [...new Set(found)].sort();
}

export function registeredRoutes(
  registry: ContractRegistry,
): readonly string[] {
  const found: string[] = [];
  for (const [path, item] of registry.paths) {
    for (const method of Object.keys(item)) {
      found.push(`${method.toUpperCase()} ${normalise(path)}`);
    }
  }
  return found.sort();
}

export function compareRoutes(
  mounted: readonly string[],
  registered: readonly string[],
  options: { readonly ignore?: readonly string[] } = {},
): RouteMismatch {
  const ignored = new Set(options.ignore ?? []);
  const registeredSet = new Set(registered);
  const mountedSet = new Set(mounted);

  return {
    mountedButUnregistered: mounted
      .filter((route) => !registeredSet.has(route) && !ignored.has(route))
      .sort(),
    registeredButUnmounted: registered
      .filter((route) => !mountedSet.has(route))
      .sort(),
  };
}

/** `:param` and `{param}` are the same route; the document uses OpenAPI's form. */
function normalise(path: string): string {
  return `/${path.replace(/^\/+/, "").replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`;
}
