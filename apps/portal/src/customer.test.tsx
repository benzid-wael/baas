import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomerScreen } from "./customer.js";
import { ApiClient } from "./api.js";
import type { PortalConfig } from "./config.js";
import type { CustomerSummaryWire } from "@baas/contracts";

/**
 * The customer screens (MP-7b).
 *
 * Weighted towards the cases that go wrong quietly: an absent balance, an
 * empty list, a customer that is not there, and a disabled control that does
 * not say why.
 */
const CONFIG: PortalConfig = {
  apiBaseUrl: "https://baas.example",
  oidcIssuer: "https://idp.example",
  oidcClientId: "portal",
};

const CUSTOMER: CustomerSummaryWire = {
  customerId: "0192f3a4-5b6c-7d8e-8f90-00000000000c",
  externalUserUuid: "0192f3a4-5b6c-7d8e-8f90-000000000001",
  providers: [],
};

const ACCOUNTS = {
  accounts: [
    {
      accountReference: "DEMO-ACCT-RECENT",
      providerId: "demo",
      product: "current_account",
      currency: "AED",
      status: "active",
      statusReason: null,
      iban: null,
      accountNumber: null,
      sortCode: null,
      bic: null,
      openedAt: null,
      balance: {
        kind: "observed",
        available: { amount: "1234.50", currency: "AED" },
        current: { amount: "1234.50", currency: "AED" },
        observedAt: "2026-09-28T12:00:00.000Z",
        ageSeconds: 660,
        fresh: false,
      },
    },
    {
      accountReference: "DEMO-ACCT-SILENT",
      providerId: "demo",
      product: "current_account",
      currency: "USD",
      status: "active",
      statusReason: null,
      iban: null,
      accountNumber: null,
      sortCode: null,
      bic: null,
      openedAt: null,
      balance: { kind: "unavailable", reason: "never_observed" },
    },
  ],
};

const TRANSACTIONS = {
  items: [
    {
      transactionReference: "TXN-1",
      accountReference: "DEMO-ACCT-RECENT",
      direction: "debit",
      amount: { amount: "10.00", currency: "AED" },
      status: "settled",
      counterpartyName: "A Merchant",
      narrative: null,
      occurredAt: "2026-09-28T11:00:00.000Z",
    },
  ],
};

interface Answer {
  status: number;
  body: unknown;
}

function api(responder: (path: string) => Answer): {
  client: ApiClient;
  paths: string[];
} {
  const paths: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = url.replace("https://baas.example", "");
    paths.push(path);
    const answer = responder(path);
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { client: new ApiClient(CONFIG, fetchImpl), paths };
}

/** The first account's Transactions button. */
function transactionsButton(): HTMLElement {
  const [first] = screen.getAllByRole("button", { name: /^transactions$/i });
  if (first === undefined) {
    throw new Error("no Transactions button was rendered");
  }
  return first;
}

const happy = (path: string): Answer => {
  if (path.startsWith("/platform/customers?"))
    return { status: 200, body: CUSTOMER };
  if (path.includes("/accounts?") || path.endsWith("/accounts"))
    return { status: 200, body: ACCOUNTS };
  if (path.includes("/transactions"))
    return { status: 200, body: TRANSACTIONS };
  return { status: 404, body: {} };
};

async function searchFor(
  responder: (path: string) => Answer = happy,
  value = "0192f3a4-5b6c-7d8e-8f90-000000000001",
): Promise<{ paths: string[] }> {
  const { client, paths } = api(responder);
  render(<CustomerScreen api={client} />);
  await userEvent.type(screen.getByLabelText(/value/i), value);
  await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
  return { paths };
}

describe("the search form", () => {
  it("disables the button while empty, and says why", () => {
    // Finding F1: a disabled control that does not explain itself is a dead
    // end the operator has to guess their way out of.
    const { client } = api(happy);
    render(<CustomerScreen api={client} />);
    expect(
      screen
        .getByRole("button", { name: /^search$/i })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByRole("note").textContent).toMatch(/enter a value/i);
  });

  it("says out loud that lookups are recorded", () => {
    const { client } = api(happy);
    render(<CustomerScreen api={client} />);
    expect(screen.getByText(/recorded against your name/i)).toBeDefined();
  });

  it("searches by exactly one identifier", async () => {
    // The API refuses both or neither. The form can only ever send one, which
    // makes that rule visible rather than a property of an endpoint.
    const { paths } = await searchFor();
    const search = paths.find((path) =>
      path.startsWith("/platform/customers?"),
    );
    expect(search).toBe(
      "/platform/customers?externalUserUuid=0192f3a4-5b6c-7d8e-8f90-000000000001",
    );
    expect(search).not.toContain("accountReference");
  });

  it("can search by account reference instead", async () => {
    const { client, paths } = api(happy);
    render(<CustomerScreen api={client} />);
    await userEvent.selectOptions(
      screen.getByLabelText(/search by/i),
      "accountReference",
    );
    await userEvent.type(screen.getByLabelText(/value/i), "DEMO-ACCT-RECENT");
    await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await vi.waitFor(() => {
      expect(paths[0]).toBe(
        "/platform/customers?accountReference=DEMO-ACCT-RECENT",
      );
    });
  });

  it("escapes what it puts in the query", async () => {
    const { paths } = await searchFor(happy, "a value/with&things");
    expect(paths[0]).toContain("a%20value%2Fwith%26things");
  });
});

describe("when there is no such customer", () => {
  it("says so plainly, rather than showing an error", async () => {
    // Reading any customer is this role's job, so there is no existence to
    // protect and the mobile surface's 404-means-maybe is not copied.
    await searchFor(() => ({ status: 404, body: {} }));
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "No customer matches that.",
    );
  });

  it("shows a real failure as a failure", async () => {
    await searchFor(() => ({ status: 500, body: {} }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /at our end/i,
    );
  });
});

describe("the accounts a customer has", () => {
  it("lists them with their balances", async () => {
    await searchFor();
    expect(await screen.findByText("DEMO-ACCT-RECENT")).toBeDefined();
    expect(screen.getByText(/1234\.50 AED/)).toBeDefined();
    expect(screen.getByText(/as of 11 minutes ago/)).toBeDefined();
  });

  it("shows an absent balance as absent, never as a figure", async () => {
    // Finding F4, at the level the operator actually sees.
    await searchFor();
    await screen.findByText("DEMO-ACCT-SILENT");
    const row = screen.getByText("DEMO-ACCT-SILENT").closest("tr");
    expect(row?.textContent).toMatch(/not available/i);
    expect(row?.textContent).not.toMatch(/0\.00/);
  });

  it("says when there are none, rather than showing a blank", async () => {
    // An empty list and a list that failed to load look identical if neither
    // says anything.
    await searchFor((path) =>
      path.startsWith("/platform/customers?")
        ? { status: 200, body: CUSTOMER }
        : { status: 200, body: { accounts: [] } },
    );
    expect((await screen.findByRole("status")).textContent).toMatch(
      /no accounts/i,
    );
  });
});

describe("transactions", () => {
  it("are not fetched until they are asked for", async () => {
    // One account's transactions are a separate, separately audited read.
    const { paths } = await searchFor();
    await screen.findByText("DEMO-ACCT-RECENT");
    expect(paths.some((path) => path.includes("/transactions"))).toBe(false);
  });

  it("load for the account whose button was pressed", async () => {
    const { paths } = await searchFor();
    await screen.findByText("DEMO-ACCT-RECENT");
    await userEvent.click(transactionsButton());

    expect(await screen.findByText(/A Merchant/)).toBeDefined();
    expect(
      paths.some((path) =>
        path.includes("/platform/accounts/DEMO-ACCT-RECENT/transactions"),
      ),
    ).toBe(true);
  });

  it("show a debit as a debit", async () => {
    await searchFor();
    await screen.findByText("DEMO-ACCT-RECENT");
    await userEvent.click(transactionsButton());
    expect((await screen.findByText(/A Merchant/)).textContent).toContain("−");
  });

  it("say when an account has none", async () => {
    await searchFor((path) =>
      path.includes("/transactions")
        ? { status: 200, body: { items: [] } }
        : happy(path),
    );
    await screen.findByText("DEMO-ACCT-RECENT");
    await userEvent.click(transactionsButton());
    expect(
      await screen.findByText(/no transactions for this account/i),
    ).toBeDefined();
  });
});
