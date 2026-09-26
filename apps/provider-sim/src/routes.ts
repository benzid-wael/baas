import type { ProviderKind } from "./delivery.js";
import type { Scenario } from "./scenario.js";

/**
 * The simulator's surface is a declarative route table, filled in by each
 * adapter as it lands, rather than a guess at every partner endpoint now.
 *
 * The same discipline as the contract registry (T7): what exists is what
 * somebody deliberately declared. Inventing twenty Keel endpoints today would
 * mean inventing twenty shapes that the real adapters then contradict, and the
 * simulator would be quietly wrong in exactly the way that makes a simulator
 * worse than nothing.
 *
 * What is built now is the machinery under the table: signing, delivery
 * scenarios, the request log, and the routing itself.
 */
export interface SimRoute {
  readonly provider: ProviderKind;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Exact path, or one containing `:name` segments. */
  readonly path: string;
  /** Whether the request must carry a valid signature to be served. */
  readonly signed: boolean;
  readonly handle: (request: SimRequest) => SimResult;
}

export interface SimRequest {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
  readonly scenario: Scenario;
}

export interface SimResult {
  readonly status: number;
  readonly body: unknown;
  /**
   * When present, the partner accepted an asynchronous operation and a
   * webhook is scheduled against it.
   */
  readonly accepted?: {
    readonly reference: string;
    readonly eventType: string;
    readonly states: { readonly accepted: string; readonly settled: string };
  };
}

export interface RouteMatch {
  readonly route: SimRoute;
  readonly params: Readonly<Record<string, string>>;
}

export function matchRoute(
  routes: readonly SimRoute[],
  method: string,
  path: string,
): RouteMatch | undefined {
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }
    const params = matchPath(route.path, path);
    if (params !== undefined) {
      return { route, params };
    }
  }
  return undefined;
}

function matchPath(
  pattern: string,
  actual: string,
): Readonly<Record<string, string>> | undefined {
  const expected = pattern.split("/").filter((segment) => segment.length > 0);
  const given = actual.split("/").filter((segment) => segment.length > 0);
  if (expected.length !== given.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const value = given[index];
    /* c8 ignore next 3 -- lengths were compared above */
    if (value === undefined) {
      return undefined;
    }
    if (segment.startsWith(":")) {
      params[segment.slice(1)] = decodeURIComponent(value);
    } else if (segment !== value) {
      return undefined;
    }
  }
  return params;
}

/**
 * The only routes declared today: a health check per provider, which proves
 * the table, the matcher and the request log without asserting anything about
 * a partner's API that has not been read from its adapter.
 */
export const BASELINE_ROUTES: readonly SimRoute[] = [
  {
    provider: "keel",
    method: "GET",
    path: "/keel/health",
    signed: false,
    handle: () => ({ status: 200, body: { status: "ok", provider: "keel" } }),
  },
  {
    provider: "ruya",
    method: "GET",
    path: "/ruya/health",
    signed: false,
    handle: () => ({ status: 200, body: { status: "ok", provider: "ruya" } }),
  },
];
