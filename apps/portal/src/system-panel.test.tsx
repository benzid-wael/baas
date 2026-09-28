import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SystemStateWire } from "@baas/contracts";
import { SystemPanel } from "./system-panel.js";
import { ApiClient } from "./api.js";
import type { PortalConfig } from "./config.js";

/**
 * The system screen (MP-8).
 *
 * The assertion that matters throughout: **the reason, not the red dot**. A
 * screen that renders all four reasons identically throws away the distinction
 * the service goes to some trouble to make, and puts back the hours finding A1
 * cost.
 */
const CONFIG: PortalConfig = {
  apiBaseUrl: "https://baas.example",
  oidcIssuer: "https://idp.example",
  oidcClientId: "portal",
};

function state(overrides: Partial<SystemStateWire> = {}): SystemStateWire {
  return {
    migrations: {
      applied: ["0001_core.sql"],
      lastAppliedAt: "2026-09-28T10:00:00.000Z",
    },
    schema: { matches: true, undeclared: [], missing: [] },
    outbox: { depths: [], unresolved: 0 },
    inbox: { unprocessed: 0, rejectedSignatures: 0 },
    capabilities: {
      service: "baas",
      appEnv: "dev",
      tenants: ["sc"],
      providers: [],
      checkedAt: "2026-09-28T10:00:00.000Z",
    },
    ...overrides,
  };
}

function panel(body: SystemStateWire | { status: number }): void {
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      "status" in body
        ? new Response("{}", { status: body.status })
        : new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
  render(<SystemPanel api={new ApiClient(CONFIG, fetchImpl)} />);
}

const withProviders = (
  providers: SystemStateWire["capabilities"]["providers"],
): SystemStateWire =>
  state({
    capabilities: { ...state().capabilities, providers },
  });

describe("what is on, and why", () => {
  it("says an available provider is available, and what it can do", async () => {
    panel(
      withProviders([
        { provider: "keel", available: true, operations: ["account.read"] },
      ]),
    );
    expect(await screen.findByText(/available/)).toBeDefined();
    expect(screen.getByText(/account\.read/)).toBeDefined();
  });

  it("gives each of the four reasons its own sentence", async () => {
    // A red dot says "something is wrong". These say which of four different
    // people should be looking at it.
    panel(
      withProviders([
        {
          provider: "a",
          available: false,
          reason: "not_configured",
          operations: [],
        },
        {
          provider: "b",
          available: false,
          reason: "adapter_absent",
          operations: [],
        },
        {
          provider: "c",
          available: false,
          reason: "disabled_by_configuration",
          operations: [],
        },
        {
          provider: "d",
          available: false,
          reason: "operation_not_implemented",
          operations: [],
        },
      ]),
    );

    expect(await screen.findByText(/holds the credentials/i)).toBeDefined();
    expect(screen.getByText(/ships the code/i)).toBeDefined();
    expect(screen.getByText(/turned off deliberately/i)).toBeDefined();
    expect(
      screen.getByText(/implements none of its operations/i),
    ).toBeDefined();
  });

  it("never shows a bare machine code for a reason it knows", async () => {
    panel(
      withProviders([
        {
          provider: "a",
          available: false,
          reason: "not_configured",
          operations: [],
        },
      ]),
    );
    await screen.findByText(/holds the credentials/i);
    expect(screen.queryByText(/^not_configured$/)).toBeNull();
  });

  it("shows an unknown reason rather than swallowing it", async () => {
    // A reason the service grew and this screen has not learned. An
    // unexplained code is worse than a sentence and far better than silence.
    panel(
      withProviders([
        {
          provider: "a",
          available: false,
          reason: "something_new",
          operations: [],
        },
      ]),
    );
    expect(await screen.findByText(/something_new/)).toBeDefined();
  });

  it("says when no provider is configured, rather than showing nothing", async () => {
    panel(state());
    expect(await screen.findByText(/no provider is configured/i)).toBeDefined();
  });
});

describe("the queues", () => {
  it("leads with the effects nobody has an outcome for", async () => {
    panel(
      state({
        outbox: {
          unresolved: 3,
          depths: [
            { state: "pending", count: 2, oldestAgeSeconds: 120 },
            { state: "unknown", count: 1, oldestAgeSeconds: 7200 },
          ],
        },
      }),
    );
    expect(
      await screen.findByText(/effects awaiting an outcome/i),
    ).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    // The breakdown carries the age in words, not a raw second count.
    expect(screen.getByText(/2 hours ago/)).toBeDefined();
  });

  it("says nothing alarming when a rejected signature count is zero", async () => {
    panel(state());
    await screen.findByText(/callbacks that failed their signature/i);
    expect(screen.queryByText(/someone probing/i)).toBeNull();
  });

  it("names both explanations when the count is not zero", async () => {
    // One is unremarkable; a rising count is a rotated credential or someone
    // probing. The screen asks the question rather than answering it.
    panel(state({ inbox: { unprocessed: 0, rejectedSignatures: 4 } }));
    expect(await screen.findByText(/someone probing/i)).toBeDefined();
  });
});

describe("the schema", () => {
  it("says so plainly when it matches", async () => {
    panel(state());
    expect(
      await screen.findByText(/matches what this build declares/i),
    ).toBeDefined();
  });

  it("names the columns that drifted", async () => {
    // Finding C1: readiness already fails on drift. The useful answer at three
    // in the morning is which column disagrees.
    panel(
      state({
        schema: {
          matches: false,
          undeclared: ["tenant.drifted"],
          missing: ["account.ghost"],
        },
      }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("tenant.drifted");
    expect(alert.textContent).toContain("account.ghost");
  });
});

describe("when it cannot load", () => {
  it("says so in our words", async () => {
    panel({ status: 500 });
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /at our end/i,
    );
  });
});
