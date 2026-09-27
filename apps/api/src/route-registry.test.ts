import { afterEach, describe, expect, it } from "vitest";
import "reflect-metadata";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { RegistryBuilder, buildRegistry } from "@baas/contracts";
import { z } from "zod";
import { Public } from "./decorators.js";
import {
  compareRoutes,
  mountedRoutes,
  registeredRoutes,
} from "./route-registry.js";

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

@Controller("accounts")
class AccountsProbeController {
  @Get()
  @Public()
  list(): [] {
    return [];
  }

  @Get(":accountReference")
  @Public()
  one(): Record<string, never> {
    return {};
  }
}

@Module({ controllers: [AccountsProbeController] })
class ProbeModule {}

async function start(): Promise<INestApplication> {
  app = await NestFactory.create(ProbeModule, { logger: false });
  await app.init();
  return app;
}

const pathItem = (operationId: string) => ({
  get: { operationId, summary: "", responses: {} },
});

describe("reading the mounted route table", () => {
  it("finds the routes Nest actually mounted, in OpenAPI form", async () => {
    const routes = mountedRoutes(await start());
    expect(routes).toEqual([
      "GET /accounts",
      "GET /accounts/{accountReference}",
    ]);
  });

  it("returns nothing rather than guessing if Nest's internals move", () => {
    // Narrow and defensive on purpose: an empty result makes the comparison
    // fail loudly, where a lenient reader would pass by accident.
    const fake = {
      getHttpAdapter: () => ({ getInstance: () => ({}) }),
    } as unknown as INestApplication;
    expect(mountedRoutes(fake)).toEqual([]);
  });
});

describe("comparing routes with the registry", () => {
  it("agrees when both sides match", async () => {
    const registry = new RegistryBuilder()
      .path("/accounts", pathItem("listAccounts"))
      .path("/accounts/{accountReference}", pathItem("getAccount"))
      .build();

    expect(
      compareRoutes(mountedRoutes(await start()), registeredRoutes(registry)),
    ).toEqual({ mountedButUnregistered: [], registeredButUnmounted: [] });
  });

  it("reports an endpoint that exists and is undocumented", async () => {
    const registry = new RegistryBuilder()
      .path("/accounts", pathItem("listAccounts"))
      .build();

    expect(
      compareRoutes(mountedRoutes(await start()), registeredRoutes(registry))
        .mountedButUnregistered,
    ).toEqual(["GET /accounts/{accountReference}"]);
  });

  it("reports a documented endpoint that does not exist", async () => {
    // The worse of the two: a client will be written against it.
    const registry = new RegistryBuilder()
      .path("/accounts", pathItem("listAccounts"))
      .path("/accounts/{accountReference}", pathItem("getAccount"))
      .path("/ghost", pathItem("ghost"))
      .build();

    expect(
      compareRoutes(mountedRoutes(await start()), registeredRoutes(registry))
        .registeredButUnmounted,
    ).toEqual(["GET /ghost"]);
  });

  it("treats :param and {param} as the same route", async () => {
    const registry = new RegistryBuilder()
      .path("/accounts", pathItem("listAccounts"))
      .path("/accounts/:accountReference", pathItem("getAccount"))
      .build();

    expect(
      compareRoutes(mountedRoutes(await start()), registeredRoutes(registry)),
    ).toEqual({ mountedButUnregistered: [], registeredButUnmounted: [] });
  });

  it("allows an explicit ignore list, for routes that are not contract", async () => {
    const registry = new RegistryBuilder()
      .path("/accounts", pathItem("listAccounts"))
      .build();

    expect(
      compareRoutes(mountedRoutes(await start()), registeredRoutes(registry), {
        ignore: ["GET /accounts/{accountReference}"],
      }).mountedButUnregistered,
    ).toEqual([]);
  });
});

describe("the published registry", () => {
  it("registers the M1 read schemas", () => {
    const registry = buildRegistry();
    for (const name of [
      "Account",
      "AccountList",
      "Balance",
      "Transaction",
      "TransactionPage",
      "Statement",
    ]) {
      expect([...registry.schemas.keys()]).toContain(name);
    }
  });

  it("registers the read paths that M1-8 mounted, and no others", () => {
    // Paths arrive with their controllers. A documented endpoint that does
    // not exist is worse than an undocumented one, so this list grows only
    // when a controller does.
    expect([...buildRegistry().paths.keys()].sort()).toEqual([
      "/mobile/accounts",
      "/mobile/accounts/{accountReference}",
      "/mobile/accounts/{accountReference}/transactions",
      "/platform/accounts/{accountReference}/transactions",
      "/platform/customers",
      "/platform/customers/{customerId}/accounts",
      "/platform/provider-requests",
      "/platform/provider-requests/{id}",
      "/platform/system",
    ]);
  });

  it("round-trips a balance in each of its three shapes", () => {
    const balance = buildRegistry().schemas.get("Balance") as z.ZodType;
    for (const value of [
      {
        kind: "observed",
        available: { amount: "1234.50", currency: "AED" },
        current: { amount: "1300.00", currency: "AED" },
        observedAt: "2026-09-27T12:00:00.000Z",
        ageSeconds: 660,
        fresh: false,
      },
      { kind: "unavailable", reason: "provider_unreachable" },
      { kind: "unavailable", reason: "never_observed" },
    ]) {
      expect(balance.safeParse(value).success).toBe(true);
    }
  });

  it("refuses a balance with a non-canonical amount", () => {
    const balance = buildRegistry().schemas.get("Balance") as z.ZodType;
    expect(
      balance.safeParse({
        kind: "observed",
        available: { amount: "1234.5", currency: "AED" },
        current: { amount: "1300.00", currency: "AED" },
        observedAt: "2026-09-27T12:00:00.000Z",
        ageSeconds: 0,
        fresh: true,
      }).success,
    ).toBe(false);
  });
});
