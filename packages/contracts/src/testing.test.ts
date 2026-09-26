import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertRoundTrip, roundTrip } from "./testing.js";
import { capabilityReportSchema } from "./contracts.js";
import { errorResponseSchema } from "./errors.js";
import { moneySchema } from "./primitives.js";

describe("roundTrip", () => {
  it("passes a value that survives serialisation", () => {
    const result = roundTrip(moneySchema, { amount: "11.00", currency: "AED" });
    expect(result.ok).toBe(true);
  });

  it("rejects a value that does not satisfy its own schema", () => {
    const result = roundTrip(moneySchema, {
      amount: "11",
      currency: "AED",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.reason).toContain(
      "does not satisfy its own schema",
    );
  });

  it("catches a field that disappears in transit", () => {
    // The E5 shape: a field is accepted, persisted, and silently absent when
    // read back. Here `optional` is dropped because undefined does not
    // survive JSON, which a schema alone would not notice.
    const schema = z.object({
      kept: z.string(),
      dropped: z.string().optional(),
    });
    const result = roundTrip(schema, { kept: "a", dropped: undefined });
    expect(result.ok).toBe(true); // undefined round-trips as absent, legitimately

    // A Set is the honest example here. It serialises to `{}` and fails to
    // parse back, which is exactly the shape of the incumbent's JSONB defect:
    // accepted on the way in, unrecognisable on the way out.
    const lossy = z.object({ codes: z.set(z.string()) });
    const lossyResult = roundTrip(lossy, { codes: new Set(["a"]) });
    expect(lossyResult.ok).toBe(false);
    expect(!lossyResult.ok && lossyResult.failure.reason).toContain(
      "after a round trip",
    );
  });

  it("catches a value that cannot be serialised at all", () => {
    const schema = z.object({ big: z.bigint() });
    const result = roundTrip(schema, { big: 1n });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.reason).toContain("not serialisable");
  });

  it("throws with both sides when used as an assertion", () => {
    expect(() =>
      assertRoundTrip(z.object({ codes: z.set(z.string()) }), {
        codes: new Set(["a"]),
      }),
    ).toThrow(/Round trip failed/);
  });
});

describe("every published schema round-trips", () => {
  // RFC-BaaS §9 makes this mandatory for anything persisted as JSON. Applying
  // it to the published contracts keeps the rule visible from the start.
  it("Money", () => {
    assertRoundTrip(moneySchema, { amount: "1.234", currency: "KWD" });
  });

  it("ErrorResponse", () => {
    assertRoundTrip(errorResponseSchema, {
      code: "domain.money.currency_mismatch",
      message: "Cannot combine AED with USD",
      correlationId: "req-1",
      details: [{ path: "amount.currency", message: "expected AED" }],
    });
  });

  it("CapabilityReport", () => {
    assertRoundTrip(capabilityReportSchema, {
      service: "baas",
      appEnv: "dev",
      tenants: ["superchat"],
      providers: [
        {
          provider: "keel",
          available: false,
          reason: "not-configured",
          operations: [],
        },
      ],
      checkedAt: "2026-09-26T12:00:00.000Z",
    });
  });
});
