import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "reflect-metadata";
import { generateKeyPairSync } from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createLogger } from "@baas/platform";
import { AppModule } from "./app.module.js";

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

const SECRET = "client-secret";
const HASH = bcrypt.hashSync(SECRET, 10);

let app: INestApplication;

/** `getHttpServer()` is typed as `any` by Nest; narrowed once, here. */
function server(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

beforeAll(async () => {
  const moduleRef = AppModule.withDependencies({
    clients: {
      byClientId: (id) =>
        Promise.resolve(
          id === "bff"
            ? {
                id: "client-1",
                tenantId: "tenant-1",
                secretHash: HASH,
                disabled: false,
                scopes: ["mobile:accounts"],
                roles: ["operator"],
              }
            : undefined,
        ),
    },
    customers: {
      byExternalUuid: () => Promise.resolve({ customerId: "cust-1" }),
    },
    assertion: {
      publicKeyPem: publicKey,
      issuer: "https://bff.test",
      audience: "baas",
    },
    capabilities: {
      capabilities: () => Promise.resolve({ service: "baas", providers: [] }),
      ready: () => Promise.resolve({ ready: true, checks: { schema: true } }),
    },
    logger,
    mountUnguardedProbe: true,
  });

  app = await NestFactory.create(moduleRef, { logger: false });
  // Listening, not merely initialised (New-26).
  //
  // Supertest starts a server itself when handed one that is not listening,
  // and **closes it again once the request settles** -- a listen and a close
  // per request. A request dispatched while that close is in flight fails with
  // `socket hang up`, which is what made the suite fail about one run in four.
  // Once the server is already listening, supertest reuses the address and
  // never closes anything. `app.close()` in `afterAll` still shuts it down.
  await app.listen(0);
}, 60_000);

afterAll(async () => {
  await app.close();
});

const auth = { "x-sc-client-id": "bff", "x-sc-client-secret": SECRET };

describe("the guard chain, end to end", () => {
  it("serves an explicitly public route with no credentials", async () => {
    const response = await request(server()).get("/system/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("refuses an authenticated route with no credentials", async () => {
    const response = await request(server()).get("/system/version");
    expect(response.status).toBe(401);
  });

  it("serves an authenticated route with valid credentials", async () => {
    const response = await request(server()).get("/system/version").set(auth);
    expect(response.status).toBe(200);
  });

  it("refuses a route that declares no authorization policy", async () => {
    // The whole point of the backstop: a controller somebody forgot to
    // annotate is unreachable rather than open.
    const response = await request(server()).get("/unguarded").set(auth);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain(
      "must never be reachable",
    );
  });

  it("enforces a role", async () => {
    const response = await request(server())
      .get("/system/capabilities")
      .set(auth);
    expect(response.status).toBe(200);
  });

  it("refuses a role the client does not hold", async () => {
    const restricted = await request(server())
      .get("/system/capabilities")
      .set({ ...auth, "x-sc-client-id": "bff", "x-sc-client-secret": "wrong" });
    expect(restricted.status).toBe(401);
  });

  it("reports readiness from a schema check, not a migration ledger", async () => {
    const response = await request(server()).get("/system/ready");
    expect(response.body).toMatchObject({
      ready: true,
      checks: { schema: true },
    });
  });

  it("does not honour a user assertion on a non-mobile route", async () => {
    const token = jwt.sign({ sub: "user-1" }, privateKey, {
      algorithm: "ES256",
      issuer: "https://bff.test",
      audience: "baas",
      expiresIn: "60s",
    });
    const response = await request(server())
      .get("/system/version")
      .set({
        ...auth,
        "x-sc-user-uuid": "user-1",
        "x-sc-user-assertion": token,
      });
    expect(response.status).toBe(200);
  });
});
