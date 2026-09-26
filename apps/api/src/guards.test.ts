import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { createLogger } from "@baas/platform";
import {
  ApiClientGuard,
  AuthorizationPolicyGuard,
  RolesGuard,
  UserUuidResolverGuard,
} from "./guards.js";
import type { ApiClientRecord } from "./guards.js";
import {
  MOBILE_SURFACE_KEY,
  PUBLIC_KEY,
  ROLES_KEY,
  ROLE_ADMIN,
  ROLE_APPROVER,
  SCOPES_KEY,
} from "./decorators.js";
import { PRINCIPAL_KEY } from "./principal.js";
import type { RequestWithPrincipal } from "./principal.js";
import { AssertionError, verifyAssertion } from "./assertion.js";

const logger = createLogger({
  service: "t",
  environment: "test",
  level: "silent",
});

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const ASSERTION = {
  publicKeyPem: publicKey,
  issuer: "https://bff.test",
  audience: "baas",
};

const SECRET = "a-client-secret";
const CLIENT: ApiClientRecord = {
  id: "client-1",
  tenantId: "tenant-1",
  secretHash: bcrypt.hashSync(SECRET, 10),
  disabled: false,
  scopes: ["mobile:accounts"],
  roles: [],
};

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

function request(headers: Record<string, string>): RequestWithPrincipal {
  return { headers, url: "/test", method: "GET" };
}

const clients = {
  byClientId: (id: string) =>
    Promise.resolve(id === "mobile-bff" ? CLIENT : undefined),
};

const credentials = {
  "x-sc-client-id": "mobile-bff",
  "x-sc-client-secret": SECRET,
};

describe("1 · ApiClientGuard", () => {
  const guard = (values: Record<string, unknown> = {}) =>
    new ApiClientGuard(reflector(values), clients, logger);

  it("authenticates a client and resolves its tenant from the credential", async () => {
    const req = request(credentials);
    await expect(guard().canActivate(context(req))).resolves.toBe(true);
    expect(req[PRINCIPAL_KEY]).toMatchObject({
      tenantId: "tenant-1",
      apiClientId: "client-1",
    });
  });

  it("never takes the tenant from a header the caller controls", async () => {
    const req = request({ ...credentials, "x-sc-tenant-id": "tenant-evil" });
    await guard().canActivate(context(req));
    expect(req[PRINCIPAL_KEY]?.tenantId).toBe("tenant-1");
  });

  it.each([
    ["no credentials", {}],
    ["wrong secret", { ...credentials, "x-sc-client-secret": "nope" }],
    ["unknown client", { ...credentials, "x-sc-client-id": "ghost" }],
  ])("rejects %s", async (_label, headers) => {
    await expect(
      guard().canActivate(context(request(headers))),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a disabled client", async () => {
    const disabled = new ApiClientGuard(
      reflector({}),
      { byClientId: () => Promise.resolve({ ...CLIENT, disabled: true }) },
      logger,
    );
    await expect(
      disabled.canActivate(context(request(credentials))),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("enforces declared scopes", async () => {
    await expect(
      guard({ [SCOPES_KEY]: ["mobile:accounts"] }).canActivate(
        context(request(credentials)),
      ),
    ).resolves.toBe(true);

    await expect(
      guard({ [SCOPES_KEY]: ["mobile:payments"] }).canActivate(
        context(request(credentials)),
      ),
    ).rejects.toThrow(/missing scope: mobile:payments/);
  });

  it("lets an explicitly public route through", async () => {
    await expect(
      guard({ [PUBLIC_KEY]: true }).canActivate(context(request({}))),
    ).resolves.toBe(true);
  });
});

describe("2 · UserUuidResolverGuard (confused-deputy control)", () => {
  const customers = {
    byExternalUuid: (_tenant: string, uuid: string) =>
      Promise.resolve(uuid === "user-1" ? { customerId: "cust-1" } : undefined),
  };

  function sign(
    claims: Record<string, unknown>,
    options: jwt.SignOptions = {},
  ) {
    return jwt.sign(claims, privateKey, {
      algorithm: "ES256",
      expiresIn: "60s",
      ...options,
    });
  }

  const valid = () =>
    sign(
      { sub: "user-1" },
      { issuer: ASSERTION.issuer, audience: ASSERTION.audience },
    );

  const guard = (mobile: boolean) =>
    new UserUuidResolverGuard(
      reflector({ [MOBILE_SURFACE_KEY]: mobile }),
      customers,
      ASSERTION,
      logger,
    );

  function authenticated(
    headers: Record<string, string>,
  ): RequestWithPrincipal {
    const req = request(headers);
    req[PRINCIPAL_KEY] = {
      tenantId: "tenant-1",
      apiClientId: "client-1",
      scopes: [],
      roles: [],
    };
    return req;
  }

  it("ignores an assertion on a route that is not a mobile surface", async () => {
    // A stolen assertion cannot be replayed against an operator route,
    // because that route never looks at one.
    const req = authenticated({
      "x-sc-user-uuid": "user-1",
      "x-sc-user-assertion": valid(),
    });
    await expect(guard(false).canActivate(context(req))).resolves.toBe(true);
    expect(req[PRINCIPAL_KEY]?.customerId).toBeUndefined();
  });

  it("resolves the customer on a mobile surface", async () => {
    const req = authenticated({
      "x-sc-user-uuid": "user-1",
      "x-sc-user-assertion": valid(),
    });
    await expect(guard(true).canActivate(context(req))).resolves.toBe(true);
    expect(req[PRINCIPAL_KEY]).toMatchObject({
      customerId: "cust-1",
      externalUserUuid: "user-1",
    });
    expect(req[PRINCIPAL_KEY]?.roles).toContain("customer");
  });

  it("refuses an assertion whose subject is not the claimed user", async () => {
    const req = authenticated({
      "x-sc-user-uuid": "user-2",
      "x-sc-user-assertion": valid(),
    });
    await expect(guard(true).canActivate(context(req))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("refuses when client authentication has not run", async () => {
    await expect(
      guard(true).canActivate(
        context(
          request({
            "x-sc-user-uuid": "user-1",
            "x-sc-user-assertion": valid(),
          }),
        ),
      ),
    ).rejects.toThrow(/client authentication must precede/);
  });

  it("refuses an unknown customer", async () => {
    const token = sign(
      { sub: "ghost" },
      { issuer: ASSERTION.issuer, audience: ASSERTION.audience },
    );
    const req = authenticated({
      "x-sc-user-uuid": "ghost",
      "x-sc-user-assertion": token,
    });
    await expect(guard(true).canActivate(context(req))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe("T9 · the assertion requires iss and aud in every environment (N1)", () => {
  function sign(options: jwt.SignOptions) {
    return jwt.sign({ sub: "user-1" }, privateKey, {
      algorithm: "ES256",
      expiresIn: "60s",
      ...options,
    });
  }

  it("accepts an assertion carrying both", () => {
    const token = sign({
      issuer: ASSERTION.issuer,
      audience: ASSERTION.audience,
    });
    expect(verifyAssertion(token, ASSERTION).subject).toBe("user-1");
  });

  it("rejects the exact token the BFF mints today — {sub, iat, exp}", () => {
    // This is the launch blocker. The incumbent accepts it in dev and rejects
    // it in stage, so the failure is invisible until it is expensive.
    expect(() => verifyAssertion(sign({}), ASSERTION)).toThrow(AssertionError);
  });

  it("rejects a wrong issuer or audience, so a token cannot cross environments", () => {
    expect(() =>
      verifyAssertion(
        sign({ issuer: "https://elsewhere", audience: "baas" }),
        ASSERTION,
      ),
    ).toThrow(/jwt issuer invalid/);
    expect(() =>
      verifyAssertion(
        sign({ issuer: ASSERTION.issuer, audience: "other" }),
        ASSERTION,
      ),
    ).toThrow(/jwt audience invalid/);
  });

  it("refuses to verify at all when issuer or audience is unconfigured", () => {
    // Never "skip the check if it is unset". That default is what made the
    // control environment-specific in the first place.
    const token = sign({
      issuer: ASSERTION.issuer,
      audience: ASSERTION.audience,
    });
    expect(() => verifyAssertion(token, { ...ASSERTION, issuer: "" })).toThrow(
      /required in every environment/,
    );
    expect(() =>
      verifyAssertion(token, { ...ASSERTION, audience: "" }),
    ).toThrow(/required in every environment/);
  });

  it("rejects an expired assertion and a wrong algorithm", () => {
    const expired = jwt.sign({ sub: "user-1" }, privateKey, {
      algorithm: "ES256",
      issuer: ASSERTION.issuer,
      audience: ASSERTION.audience,
      expiresIn: "-10s",
    });
    expect(() => verifyAssertion(expired, ASSERTION)).toThrow(/expired/);

    const hs256 = jwt.sign({ sub: "user-1" }, "shared-secret", {
      algorithm: "HS256",
      issuer: ASSERTION.issuer,
      audience: ASSERTION.audience,
      expiresIn: "60s",
    });
    expect(() => verifyAssertion(hs256, ASSERTION)).toThrow(AssertionError);
  });
});

describe("4 · RolesGuard — admin does not satisfy approver (D1)", () => {
  function check(
    roles: string[],
    required: string[] | undefined,
  ): boolean | Error {
    const req = request({});
    req[PRINCIPAL_KEY] = {
      tenantId: "t",
      apiClientId: "c",
      scopes: [],
      roles,
    };
    try {
      return new RolesGuard(reflector({ [ROLES_KEY]: required })).canActivate(
        context(req),
      );
    } catch (error) {
      return error as Error;
    }
  }

  it("passes a route declaring no roles to the backstop", () => {
    expect(check([], undefined)).toBe(true);
  });

  it("admin satisfies an ordinary operator role", () => {
    expect(check([ROLE_ADMIN], ["operator"])).toBe(true);
  });

  it("admin does NOT satisfy approver", () => {
    // Separation of duties becomes structural rather than resting on user-id
    // comparisons inside each service.
    expect(check([ROLE_ADMIN], [ROLE_APPROVER])).toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("an explicit approver does", () => {
    expect(check([ROLE_APPROVER], [ROLE_APPROVER])).toBe(true);
  });

  it("admin does not become a customer", () => {
    expect(check([ROLE_ADMIN], ["customer"])).toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe("5 · AuthorizationPolicyGuard — deny by default", () => {
  const guard = (values: Record<string, unknown>) =>
    new AuthorizationPolicyGuard(reflector(values), logger);

  it("refuses a route that declares no policy at all", () => {
    // Forgetting to annotate a new controller cannot expose it.
    expect(() => guard({}).canActivate(context(request({})))).toThrow(
      /declares no authorization policy/,
    );
  });

  it.each([
    ["scopes", { [SCOPES_KEY]: ["mobile:accounts"] }],
    ["roles", { [ROLES_KEY]: ["operator"] }],
    ["public", { [PUBLIC_KEY]: true }],
  ])("accepts a route that declares %s", (_label, values) => {
    expect(guard(values).canActivate(context(request({})))).toBe(true);
  });

  it("logs the route it refused, so the omission is findable", () => {
    const warn = vi.fn();
    const noisy = new AuthorizationPolicyGuard(reflector({}), {
      ...logger,
      error: warn,
    });
    expect(() => noisy.canActivate(context(request({})))).toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ route: "/test" }),
      expect.stringContaining("no authorization policy"),
    );
  });
});
