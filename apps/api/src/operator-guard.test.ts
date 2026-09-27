import { describe, expect, it, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { createLogger } from "@baas/platform";
import { MixedSurfaceError, OperatorSessionGuard } from "./operator-guard.js";
import { MOBILE_SURFACE_KEY, OPERATOR_SURFACE_KEY } from "./decorators.js";
import { PRINCIPAL_KEY } from "./principal.js";
import type { RequestWithPrincipal } from "./principal.js";

const logger = createLogger({
  service: "t",
  environment: "test",
  level: "silent",
});

function reflector(values: Record<string, unknown>): Reflector {
  return {
    getAllAndOverride: (key: string) => values[key],
  } as unknown as Reflector;
}

function context(request: RequestWithPrincipal): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

const SESSION = {
  sessionId: "sess-1",
  tenantId: "tenant-1",
  operatorId: "op-1",
  roles: ["operator", "approver"],
  email: "ops@example.com",
};

function operators() {
  return {
    resolveSession: vi.fn().mockResolvedValue(SESSION),
    touch: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Separate rather than `operators(undefined)`: passing undefined explicitly
 * re-selects a default parameter, so that form silently tested the resolved
 * case and passed.
 */
function noSession() {
  return {
    resolveSession: vi.fn().mockResolvedValue(undefined),
    touch: vi.fn().mockResolvedValue(undefined),
  };
}

function guard(values: Record<string, unknown>, repo = operators()) {
  return {
    guard: new OperatorSessionGuard(
      reflector(values),
      {} as never,
      repo as never,
      logger,
    ),
    repo,
  };
}

const withToken = (token = "tok"): RequestWithPrincipal => ({
  headers: { authorization: `Bearer ${token}` },
  url: "/platform/customers",
  method: "GET",
});

describe("operator routes", () => {
  it("stands aside entirely on a route that is not an operator surface", async () => {
    const { guard: g, repo } = guard({});
    await expect(g.canActivate(context(withToken()))).resolves.toBe(true);
    expect(repo.resolveSession).not.toHaveBeenCalled();
  });

  it("establishes a principal with the operator's roles", async () => {
    const request = withToken();
    const { guard: g } = guard({ [OPERATOR_SURFACE_KEY]: true });
    await expect(g.canActivate(context(request))).resolves.toBe(true);
    expect(request[PRINCIPAL_KEY]).toMatchObject({
      tenantId: "tenant-1",
      operatorId: "op-1",
      roles: ["operator", "approver"],
    });
  });

  it("names the operator rather than borrowing an api client id", async () => {
    // So an audit row says who acted.
    const request = withToken();
    await guard({ [OPERATOR_SURFACE_KEY]: true }).guard.canActivate(
      context(request),
    );
    expect(request[PRINCIPAL_KEY]?.apiClientId).toBe("operator:op-1");
  });

  it("grants no scopes: an operator is not an API client", async () => {
    const request = withToken();
    await guard({ [OPERATOR_SURFACE_KEY]: true }).guard.canActivate(
      context(request),
    );
    expect(request[PRINCIPAL_KEY]?.scopes).toEqual([]);
  });

  it.each([
    ["no authorization header", {}],
    ["a non-bearer scheme", { authorization: "Basic abc" }],
  ])("refuses a request with %s", async (_label, headers) => {
    const { guard: g } = guard({ [OPERATOR_SURFACE_KEY]: true });
    await expect(
      g.canActivate(context({ headers, url: "/x", method: "GET" })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("refuses an unresolvable session", async () => {
    const { guard: g } = guard({ [OPERATOR_SURFACE_KEY]: true }, noSession());
    await expect(g.canActivate(context(withToken()))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("does not fail the request when recording activity fails", async () => {
    const repo = operators();
    repo.touch.mockRejectedValue(new Error("write failed"));
    const { guard: g } = guard({ [OPERATOR_SURFACE_KEY]: true }, repo);
    await expect(g.canActivate(context(withToken()))).resolves.toBe(true);
  });
});

describe("the two trust boundaries stay apart", () => {
  it("refuses a route claiming both surfaces", async () => {
    // A mobile route carries a customer identity forwarded by the BFF and may
    // touch only that customer; an operator route carries a staff session and
    // reads any customer in the tenant. A route claiming both is a route
    // where the stronger authority silently applies.
    const { guard: g } = guard({
      [OPERATOR_SURFACE_KEY]: true,
      [MOBILE_SURFACE_KEY]: true,
    });
    await expect(g.canActivate(context(withToken()))).rejects.toThrow(
      MixedSurfaceError,
    );
  });

  it("does not accept a mobile assertion as an operator session", async () => {
    // The headers are different and so is the route marker, but the property
    // is worth asserting rather than inferring from the code.
    const request: RequestWithPrincipal = {
      headers: {
        "x-sc-user-uuid": "user-1",
        "x-sc-user-assertion": "an.assertion.value",
      },
      url: "/platform/customers",
      method: "GET",
    };
    const { guard: g } = guard({ [OPERATOR_SURFACE_KEY]: true });
    await expect(g.canActivate(context(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("does not let an operator session reach a mobile route", async () => {
    // The operator guard stands aside, so nothing establishes a principal and
    // the mobile guards refuse it.
    const request = withToken();
    const { guard: g, repo } = guard({ [MOBILE_SURFACE_KEY]: true });
    await g.canActivate(context(request));
    expect(request[PRINCIPAL_KEY]).toBeUndefined();
    expect(repo.resolveSession).not.toHaveBeenCalled();
  });
});
