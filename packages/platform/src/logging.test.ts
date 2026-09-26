import { describe, expect, it } from "vitest";
import { CurrencyMismatchError } from "@baas/domain";
import {
  ALLOWED_LOG_FIELDS,
  DEPTH_LIMIT_MARKER,
  createLogger,
} from "./logging.js";

interface Captured {
  readonly records: Record<string, unknown>[];
  readonly logger: ReturnType<typeof createLogger>;
}

function capture(additionalFields?: readonly string[]): Captured {
  const records: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: "baas-test",
    environment: "test",
    level: "trace",
    ...(additionalFields === undefined ? {} : { additionalFields }),
    destination: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  return { records, logger };
}

describe("log field allow-list", () => {
  it("drops a field carrying a mobile number and never logs its value", () => {
    const { records, logger } = capture();

    logger.info(
      { customerId: "c-1", mobileNumber: "+971500000000" },
      "otp sent",
    );

    const [record] = records;
    expect(record).toBeDefined();
    expect(record?.["customerId"]).toBe("c-1");
    expect(record?.["mobileNumber"]).toBeUndefined();
    expect(record?.["droppedFields"]).toEqual(["mobileNumber"]);
    expect(JSON.stringify(record)).not.toContain("971500000000");
  });

  it("reports dropped keys so a field does not vanish silently", () => {
    const { records, logger } = capture();

    logger.warn({ iban: "AE07...", beneficiaryName: "A Person" }, "payout");

    expect(records[0]?.["droppedFields"]).toEqual(["beneficiaryName", "iban"]);
  });

  it("omits the dropped-keys field entirely when nothing was dropped", () => {
    const { records, logger } = capture();
    logger.info({ effectId: "e-1" }, "dispatched");
    expect(records[0]).not.toHaveProperty("droppedFields");
  });

  it("filters nested objects, so a permitted key cannot smuggle a payload", () => {
    const { records, logger } = capture();

    logger.info(
      {
        outcome: { state: "settled", providerRef: "R1", payerName: "A Person" },
      },
      "settled",
    );

    const outcome = records[0]?.["outcome"] as Record<string, unknown>;
    expect(outcome["state"]).toBe("settled");
    expect(outcome["providerRef"]).toBe("R1");
    expect(outcome["payerName"]).toBeUndefined();
    expect(outcome["droppedFields"]).toEqual(["payerName"]);
  });

  it("filters objects inside arrays", () => {
    const { records, logger } = capture();

    logger.info(
      { outcome: [{ state: "ok", pan: "4111111111111111" }] },
      "legs",
    );

    expect(JSON.stringify(records[0])).not.toContain("4111111111111111");
  });

  it("drops a structure nested deeper than the filter walks", () => {
    const { records, logger } = capture();

    logger.info(
      {
        outcome: {
          outcome: {
            outcome: {
              outcome: {
                outcome: { iban: "AE07...", pan: "4111" },
              },
            },
          },
        },
      },
      "deep",
    );

    const serialised = JSON.stringify(records[0]);
    expect(serialised).toContain(DEPTH_LIMIT_MARKER);
    expect(serialised).not.toContain("AE07");
    expect(serialised).not.toContain("4111");
  });

  it("keeps base fields and the message", () => {
    const { records, logger } = capture();
    logger.info({ effectId: "e-1" }, "dispatched");

    expect(records[0]?.["service"]).toBe("baas-test");
    expect(records[0]?.["environment"]).toBe("test");
    expect(records[0]?.["msg"]).toBe("dispatched");
  });

  it("serialises an error with its stable code and does not filter it", () => {
    const { records, logger } = capture();

    logger.error(
      { err: new CurrencyMismatchError("AED", "USD"), effectId: "e-1" },
      "dispatch failed",
    );

    const err = records[0]?.["err"] as Record<string, unknown>;
    expect(err["code"]).toBe("domain.money.currency_mismatch");
    expect(err["name"]).toBe("CurrencyMismatchError");
    expect(err["stack"]).toBeDefined();
  });

  it("accepts an additional field for a module with its own vocabulary", () => {
    const { records, logger } = capture(["webhookId"]);
    logger.info({ webhookId: "w-1", iban: "AE07..." }, "received");

    expect(records[0]?.["webhookId"]).toBe("w-1");
    expect(records[0]?.["droppedFields"]).toEqual(["iban"]);
  });
});

describe("the allow-list itself", () => {
  /**
   * A guard on future edits: the cheapest way for personal data to start
   * flowing into logs is for someone to add one plausible-looking field name.
   *
   * Matching is on camelCase segments, not substrings. A substring test reads
   * "pan" inside "spanId" and "mail" inside "emailless", which produces
   * failures nobody believes and a guard somebody eventually deletes.
   */
  const FORBIDDEN_SEGMENTS = new Set([
    "name",
    "email",
    "phone",
    "mobile",
    "msisdn",
    "iban",
    "bic",
    "address",
    "dob",
    "birthdate",
    "pan",
    "cvv",
    "secret",
    "token",
    "password",
    "assertion",
    "authorization",
    "document",
    "passport",
    "emirates",
  ]);

  function segmentsOf(field: string): string[] {
    return field
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((segment) => segment.length > 0);
  }

  it("splits camelCase into segments", () => {
    expect(segmentsOf("spanId")).toEqual(["span", "id"]);
    expect(segmentsOf("mobileNumber")).toEqual(["mobile", "number"]);
  });

  it("contains no field that names a person, a contact or an account", () => {
    for (const field of ALLOWED_LOG_FIELDS) {
      for (const segment of segmentsOf(field)) {
        expect(
          FORBIDDEN_SEGMENTS.has(segment),
          `"${field}" looks like personal data and is on the allow-list`,
        ).toBe(false);
      }
    }
  });

  it("would catch a personal-data field if one were added", () => {
    for (const candidate of ["mobileNumber", "beneficiaryName", "iban"]) {
      const hit = segmentsOf(candidate).some((segment) =>
        FORBIDDEN_SEGMENTS.has(segment),
      );
      expect(hit, `${candidate} should be rejected by the guard`).toBe(true);
    }
  });
});
