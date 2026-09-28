import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { BalanceWire } from "@baas/contracts";
import { Balance, ageOf } from "./balance.js";

/**
 * Finding F4, asserted rather than intended.
 *
 * The incumbent's portal rendered an absent value as a confident figure. The
 * tests that matter here are the ones that would fail if someone "simplified"
 * this component into `{balance.available.amount}`.
 */
const observed = (
  overrides: Partial<Extract<BalanceWire, { kind: "observed" }>> = {},
): BalanceWire => ({
  kind: "observed",
  available: { amount: "1234.50", currency: "AED" },
  current: { amount: "1234.50", currency: "AED" },
  observedAt: "2026-09-28T12:00:00.000Z",
  ageSeconds: 5,
  fresh: true,
  ...overrides,
});

describe("a balance we have", () => {
  it("shows the figure and its currency", () => {
    render(<Balance balance={observed()} />);
    expect(screen.getByText(/1234\.50 AED/)).toBeDefined();
  });

  it("says nothing about age when it is fresh", () => {
    render(<Balance balance={observed()} />);
    expect(screen.queryByText(/as of/)).toBeNull();
  });

  it("shows how old it is when it is not", () => {
    // A figure that might be an hour old, presented as current, is the same
    // lie as a zero — more quietly told.
    render(<Balance balance={observed({ fresh: false, ageSeconds: 660 })} />);
    expect(screen.getByText(/as of 11 minutes ago/)).toBeDefined();
  });
});

describe("a balance we do not have", () => {
  for (const reason of ["never_observed", "provider_unreachable"] as const) {
    it(`renders no figure at all for ${reason}`, () => {
      const { container } = render(
        <Balance balance={{ kind: "unavailable", reason }} />,
      );
      // The assertion that matters: no number anywhere. An absent balance
      // shown as 0.00 reads as "you have no money", which is a worse lie than
      // an error.
      expect(container.textContent).not.toMatch(/\d/);
      expect(screen.getByText(/not available/i)).toBeDefined();
    });
  }

  it("distinguishes the two reasons in words", () => {
    // They mean different things to the reader: one is "we have never had
    // this", the other "we could not get it just now". The service goes to
    // some trouble to tell them apart (C15); throwing that away here would
    // waste it.
    const { unmount } = render(
      <Balance balance={{ kind: "unavailable", reason: "never_observed" }} />,
    );
    expect(screen.getByText(/not seen a balance/i)).toBeDefined();
    unmount();

    render(
      <Balance
        balance={{ kind: "unavailable", reason: "provider_unreachable" }}
      />,
    );
    expect(screen.getByText(/could not reach the bank/i)).toBeDefined();
  });

  it("never shows the reason as a machine code", () => {
    render(
      <Balance
        balance={{ kind: "unavailable", reason: "provider_unreachable" }}
      />,
    );
    expect(screen.queryByText(/provider_unreachable/)).toBeNull();
  });
});

describe("how an age reads", () => {
  it("is coarse, because the precision is not real", () => {
    // The observation was already old when it was stored; seconds of
    // precision on top of that is a number pretending to be a measurement.
    expect(ageOf(0)).toBe("moments ago");
    expect(ageOf(59)).toBe("moments ago");
    expect(ageOf(60)).toBe("1 minute ago");
    expect(ageOf(660)).toBe("11 minutes ago");
    expect(ageOf(3600)).toBe("1 hour ago");
    expect(ageOf(7200)).toBe("2 hours ago");
    expect(ageOf(86_400)).toBe("1 day ago");
    expect(ageOf(200_000)).toBe("2 days ago");
  });
});
