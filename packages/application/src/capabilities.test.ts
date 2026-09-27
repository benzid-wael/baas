import { describe, expect, it } from "vitest";
import type {
  AccountReadPort,
  StatementReadPort,
  TransactionReadPort,
} from "@baas/domain";
import { TestClock, formatInstant, parseInstant } from "@baas/platform";
import { CapabilityRegistry } from "./capabilities.js";
import type { ProviderAdapter, ProviderDeployment } from "./capabilities.js";
import { capabilityReportSchema } from "@baas/contracts";

const START = parseInstant("2026-09-27T18:00:00.000Z");

const accounts = {} as AccountReadPort;
const transactions = {} as TransactionReadPort;
const statements = {} as StatementReadPort;

function registry(
  adapters: readonly ProviderAdapter[],
  deployment: Record<string, ProviderDeployment> = {},
) {
  return new CapabilityRegistry({
    serviceName: "baas",
    appEnv: "dev",
    adapters,
    deployment: new Map(Object.entries(deployment)),
    tenants: ["superchat"],
    clock: new TestClock(START),
    formatInstant,
  });
}

describe("operations are derived, never declared (N3)", () => {
  it("reports exactly the ports the adapter supplies", () => {
    const full = registry([
      { providerId: "keel", accounts, transactions, statements },
    ]);
    expect(full.operationsOf("keel")).toEqual([
      "account.read",
      "transaction.read",
      "statement.read",
    ]);

    const partial = registry([{ providerId: "ruya", accounts }]);
    expect(partial.operationsOf("ruya")).toEqual(["account.read"]);
  });

  it("cannot claim an operation it does not implement", () => {
    // Keel's incumbent capability array claims "cards" while its adapter has
    // no cards() method. Here, claiming an operation means passing an
    // implementation of it, so the claim and the code cannot disagree.
    const partial = registry([{ providerId: "ruya", accounts }], {
      ruya: { configured: true },
    });
    expect(partial.operationsOf("ruya")).not.toContain("statement.read");
    expect(partial.status("ruya", "statement.read")).toEqual({
      available: false,
      reason: "operation_not_implemented",
    });
  });

  it("reports nothing for a provider with no adapter", () => {
    expect(registry([]).operationsOf("ghost")).toEqual([]);
  });
});

describe("availability composes the adapter with the deployment (A1)", () => {
  it("is available when the adapter is present and configured", () => {
    expect(
      registry([{ providerId: "keel", accounts }], {
        keel: { configured: true },
      }).status("keel"),
    ).toEqual({ available: true });
  });

  it("distinguishes never configured from deliberately turned off", () => {
    // The incumbent reports one "unavailable" for both, and an operator
    // cannot tell whether to go and set something up or to go and turn
    // something on.
    const unconfigured = registry([{ providerId: "keel", accounts }], {
      keel: { configured: false },
    });
    expect(unconfigured.status("keel")).toEqual({
      available: false,
      reason: "not_configured",
    });

    const disabled = registry([{ providerId: "keel", accounts }], {
      keel: { configured: true, disabled: true },
    });
    expect(disabled.status("keel")).toEqual({
      available: false,
      reason: "disabled_by_configuration",
    });
  });

  it("distinguishes both from an adapter that is simply not there", () => {
    expect(registry([]).status("keel")).toEqual({
      available: false,
      reason: "adapter_absent",
    });
  });

  it("gives the same answer to every caller", () => {
    // Finding A1: routing built its own projection of availability and could
    // disagree with the adapter, so a defect in the adapter surfaced three
    // layers away as "No published, available bank payout route".
    const one = registry([{ providerId: "keel", accounts }], {
      keel: { configured: false },
    });
    expect(one.status("keel")).toEqual(one.status("keel", "account.read"));
    expect(one.report().providers[0]).toMatchObject({
      available: false,
      reason: "not_configured",
    });
  });
});

describe("the report", () => {
  it("satisfies the published contract", () => {
    const report = registry(
      [
        { providerId: "keel", accounts, transactions },
        { providerId: "ruya", accounts, statements },
      ],
      { keel: { configured: true }, ruya: { configured: false } },
    ).report();

    expect(capabilityReportSchema.safeParse(report).success).toBe(true);
  });

  it("lists providers in a stable order, so a diff means something", () => {
    const report = registry(
      [
        { providerId: "ruya", accounts },
        { providerId: "keel", accounts },
      ],
      { keel: { configured: true }, ruya: { configured: true } },
    ).report();
    expect(report.providers.map((p) => p.provider)).toEqual(["keel", "ruya"]);
  });

  it("carries the time it was taken, because availability is a snapshot", () => {
    expect(registry([]).report().checkedAt).toBe("2026-09-27T18:00:00.000Z");
  });

  it("omits the reason entirely when a provider is available", () => {
    const report = registry([{ providerId: "keel", accounts }], {
      keel: { configured: true },
    }).report();
    expect(report.providers[0]).not.toHaveProperty("reason");
  });
});

/**
 * Correction C10. These two cases were unreachable before New-19: `report()`
 * iterated the adapters, so a declared provider with no adapter never appeared
 * at all, and `status()` answered `adapter_absent` for both of them.
 */
describe("a declared provider with no adapter (C10)", () => {
  it("appears in the report rather than vanishing from it", () => {
    const report = registry([], { ruya: { configured: false } }).report();
    expect(report.providers.map((provider) => provider.provider)).toEqual([
      "ruya",
    ]);
  });

  it("says `not_configured` when the build supports it", () => {
    const one = new CapabilityRegistry({
      serviceName: "baas",
      appEnv: "dev",
      adapters: [],
      supportedProviders: ["ruya"],
      deployment: new Map([["ruya", { configured: false }]]),
      tenants: [],
      clock: new TestClock(START),
      formatInstant,
    });
    expect(one.status("ruya")).toEqual({
      available: false,
      reason: "not_configured",
    });
  });

  it("says `adapter_absent` when the build does not support it", () => {
    // Different reason, different person: one holds credentials, the other
    // ships code. Collapsing them is what made the incumbent debug the policy
    // layer for an adapter defect.
    const one = new CapabilityRegistry({
      serviceName: "baas",
      appEnv: "dev",
      adapters: [],
      supportedProviders: ["ruya"],
      deployment: new Map([["lulu", { configured: true }]]),
      tenants: [],
      clock: new TestClock(START),
      formatInstant,
    });
    expect(one.status("lulu")).toEqual({
      available: false,
      reason: "adapter_absent",
    });
  });

  it("says `adapter_absent` for a supported, configured provider that still has none", () => {
    // A build problem, and it must not be reported as a configuration one.
    const one = new CapabilityRegistry({
      serviceName: "baas",
      appEnv: "dev",
      adapters: [],
      supportedProviders: ["ruya"],
      deployment: new Map([["ruya", { configured: true }]]),
      tenants: [],
      clock: new TestClock(START),
      formatInstant,
    });
    expect(one.status("ruya")).toEqual({
      available: false,
      reason: "adapter_absent",
    });
  });
});
