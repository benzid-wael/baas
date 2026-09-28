import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProviderCallSummaryWire } from "@baas/contracts";
import { RequestLog } from "./request-log.js";
import { ApiClient } from "./api.js";
import type { PortalConfig } from "./config.js";

/**
 * The request log screen (MP-9, finding C4).
 *
 * "An operator surface, not a debug dump" is the criterion, and the filters
 * are what the phrase means: an incident starts with an account reference, not
 * with "show me everything".
 */
const CONFIG: PortalConfig = {
  apiBaseUrl: "https://baas.example",
  oidcIssuer: "https://idp.example",
  oidcClientId: "portal",
};

const call = (
  overrides: Partial<ProviderCallSummaryWire> = {},
): ProviderCallSummaryWire => ({
  id: "0192f3a4-5b6c-7d8e-8f90-00000000000a",
  providerId: "keel",
  operation: "GET /api/baas/v2/accounts/{accountReference}",
  correlationId: "corr-1",
  idempotencyId: null,
  accountReference: "ACC-1",
  outcome: "ok",
  responseStatus: 200,
  startedAt: "2026-09-28T12:00:00.000Z",
  durationMs: 42,
  ...overrides,
});

const DETAIL = {
  ...call(),
  requestBody: "",
  responseBody: '{"balance":"[redacted]:iban"}',
  errorMessage: null,
};

function api(responder: (path: string) => unknown): {
  client: ApiClient;
  paths: string[];
} {
  const paths: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = url.replace("https://baas.example", "");
    paths.push(path);
    return Promise.resolve(
      new Response(JSON.stringify(responder(path)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { client: new ApiClient(CONFIG, fetchImpl), paths };
}

const listOf =
  (...items: ProviderCallSummaryWire[]) =>
  (path: string): unknown =>
    path.includes("/provider-requests/") ? DETAIL : { items };

async function search(
  responder: (path: string) => unknown = listOf(call()),
  options: { by?: string; value?: string } = {},
): Promise<{ paths: string[] }> {
  const { client, paths } = api(responder);
  render(<RequestLog api={client} />);
  if (options.by !== undefined) {
    await userEvent.selectOptions(
      screen.getByLabelText(/filter by/i),
      options.by,
    );
  }
  if (options.value !== undefined) {
    await userEvent.type(screen.getByLabelText(/^value$/i), options.value);
  }
  await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
  return { paths };
}

describe("how an incident is traced", () => {
  it("offers account reference first, because that is what support has", () => {
    const { client } = api(listOf());
    render(<RequestLog api={client} />);
    expect(screen.getByLabelText(/filter by/i)).toHaveProperty(
      "value",
      "accountReference",
    );
  });

  it("filters by account reference", async () => {
    const { paths } = await search(listOf(call()), { value: "ACC-1" });
    expect(paths[0]).toContain("accountReference=ACC-1");
  });

  it("filters by correlation id", async () => {
    const { paths } = await search(listOf(call()), {
      by: "correlationId",
      value: "corr-9",
    });
    expect(paths[0]).toContain("correlationId=corr-9");
  });

  it("allows an unfiltered look, and says so before you press it", () => {
    // Sometimes "the last few calls" is exactly the question. It should not be
    // a surprise that the button works with an empty box.
    const { client } = api(listOf(call()));
    render(<RequestLog api={client} />);
    expect(screen.getByRole("note").textContent).toMatch(/most recent calls/i);
    expect(
      screen
        .getByRole("button", { name: /^search$/i })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("says when nothing matches", async () => {
    await search(() => ({ items: [] }), { value: "ACC-NOPE" });
    expect((await screen.findByRole("status")).textContent).toMatch(
      /no provider calls match/i,
    );
  });
});

describe("what the list shows", () => {
  it("shows the route, the account and how long it took", async () => {
    await search();
    expect(
      await screen.findByText("GET /api/baas/v2/accounts/{accountReference}"),
    ).toBeDefined();
    expect(screen.getByText("ACC-1")).toBeDefined();
    expect(screen.getByText("42 ms")).toBeDefined();
  });

  it("never shows a body in the list", async () => {
    // They are the reason this is the most sensitive table in the service, and
    // fifty of them on one screen answers a question the status already does.
    await search();
    await screen.findByText("ACC-1");
    expect(screen.queryByText(/redacted/)).toBeNull();
  });

  it("keeps `no answer` distinct from `refused`", async () => {
    // A call that never got an answer may still have moved money. A screen
    // that renders both as "failed" hides the one distinction that decides
    // whether it is safe to retry.
    await search(
      listOf(
        call({ id: "a", outcome: "rejected", responseStatus: 422 }),
        call({ id: "b", outcome: "unreachable", responseStatus: null }),
      ),
    );
    expect(await screen.findByText(/refused \(422\)/)).toBeDefined();
    expect(screen.getByText(/do not know whether it acted/i)).toBeDefined();
  });

  it("shows a dash when a call was not about one account", async () => {
    await search(listOf(call({ accountReference: null })));
    expect(await screen.findByText("—")).toBeDefined();
  });
});

describe("opening one call", () => {
  it("does not fetch a body until asked", async () => {
    const { paths } = await search();
    await screen.findByText("ACC-1");
    expect(paths.some((path) => path.includes("/provider-requests/"))).toBe(
      false,
    );
  });

  it("fetches the bodies when asked, and warns before they are on screen", async () => {
    const { paths } = await search();
    await screen.findByText("ACC-1");
    await userEvent.click(screen.getByRole("button", { name: /^open$/i }));

    expect(await screen.findByText(/redacted/)).toBeDefined();
    expect(
      screen.getByText(/treat what follows as customer data/i),
    ).toBeDefined();
    expect(paths.some((path) => path.includes("/provider-requests/"))).toBe(
      true,
    );
  });
});
