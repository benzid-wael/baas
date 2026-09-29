import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiClientsScreen } from "./api-clients.js";
import { ApiClient } from "./api.js";
import type { PortalConfig } from "./config.js";

/**
 * API clients and scopes (MP-10).
 *
 * Finding F1 governs the assertions: **a disabled button always says why**.
 * There are three ways this form can be blocked and each gets a test, because
 * a dead silent control is the thing the finding is about.
 */
const CONFIG: PortalConfig = {
  apiBaseUrl: "https://baas.example",
  oidcIssuer: "https://idp.example",
  oidcClientId: "portal",
};

const CLIENTS = {
  clients: [
    {
      id: "0192f3a4-5b6c-7d8e-8f90-00000000000c",
      clientId: "bff",
      name: "Mobile BFF",
      disabled: false,
      createdAt: "2026-09-28T10:00:00.000Z",
      liveScopes: ["mobile:accounts"],
    },
  ],
};

const HISTORY = {
  grants: [
    {
      id: "0192f3a4-5b6c-7d8e-8f90-00000000000d",
      scope: "mobile:accounts",
      grantedAt: "2026-09-28T10:00:00.000Z",
      grantedBy: "0192f3a4-5b6c-7d8e-8f90-00000000000e",
      revokedAt: null,
      revokedBy: null,
      reason: "the BFF reads accounts",
      live: true,
    },
    {
      id: "0192f3a4-5b6c-7d8e-8f90-00000000000f",
      scope: "mobile:transactions",
      grantedAt: "2026-09-27T10:00:00.000Z",
      grantedBy: "0192f3a4-5b6c-7d8e-8f90-00000000000e",
      revokedAt: "2026-09-28T09:00:00.000Z",
      revokedBy: "0192f3a4-5b6c-7d8e-8f90-00000000000e",
      reason: "withdrawn",
      live: false,
    },
  ],
};

interface Call {
  method: string;
  path: string;
  body: string | undefined;
}

async function mount(
  options: {
    roles?: string[];
    onScopeWrite?: () => { status: number; body?: unknown };
  } = {},
): Promise<{ calls: Call[] }> {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = url.replace("https://baas.example", "");
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path,
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    if (path === "/operator/sessions") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            token: "s",
            expiresAt: "2026-09-29T00:00:00.000Z",
            roles: options.roles ?? ["admin"],
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (method !== "GET") {
      const answer = options.onScopeWrite?.() ?? { status: 200, body: {} };
      return Promise.resolve(
        new Response(JSON.stringify(answer.body ?? {}), {
          status: answer.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    const body = path.endsWith("/scopes") ? HISTORY : CLIENTS;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  const api = new ApiClient(CONFIG, fetchImpl);
  await api.signIn("id-token");
  render(<ApiClientsScreen api={api} />);
  await screen.findByText("bff");
  await userEvent.click(screen.getByRole("button", { name: /^scopes$/i }));
  await screen.findByRole("heading", { name: /^scopes$/i });
  return { calls };
}

describe("a disabled control always says why (F1)", () => {
  it("says a scope must be chosen", async () => {
    await mount();
    expect(screen.getByRole("note").textContent).toMatch(/choose a scope/i);
    expect(
      screen.getByRole("button", { name: /^grant$/i }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("says a reason is required once a scope is chosen", async () => {
    await mount();
    await userEvent.selectOptions(
      screen.getByLabelText(/^scope$/i),
      "mobile:transactions",
    );
    expect(screen.getByRole("note").textContent).toMatch(/give a reason/i);
  });

  it("says an operator is not permitted, rather than failing at the API", async () => {
    // Offering the button and letting the server answer 403 is the dead end
    // the finding is about.
    await mount({ roles: ["operator"] });
    expect(screen.getByRole("note").textContent).toMatch(/only an admin/i);
    expect(
      screen.getByRole("button", { name: /^grant$/i }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("enables the button once both are given", async () => {
    await mount();
    await userEvent.selectOptions(
      screen.getByLabelText(/^scope$/i),
      "mobile:transactions",
    );
    await userEvent.type(screen.getByLabelText(/^reason$/i), "they need it");
    expect(
      screen.getByRole("button", { name: /^grant$/i }).hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("granting", () => {
  it("sends one scope and the reason", async () => {
    // MP-3 has no route that takes a list, and the form cannot offer one.
    const { calls } = await mount();
    await userEvent.selectOptions(
      screen.getByLabelText(/^scope$/i),
      "mobile:transactions",
    );
    await userEvent.type(screen.getByLabelText(/^reason$/i), "they need it");
    await userEvent.click(screen.getByRole("button", { name: /^grant$/i }));

    const post = calls.find(
      (call) => call.method === "POST" && call.path.endsWith("/scopes"),
    );
    expect(post).toBeDefined();
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      scope: "mobile:transactions",
      reason: "they need it",
    });
  });

  it("offers only scopes the service understands", async () => {
    // A free text field would let an operator grant `mobile:account`, see it
    // listed, and wonder why the caller still gets 403s.
    await mount();
    const options = screen
      .getAllByRole("option")
      .map((option) => option.getAttribute("value"));
    expect(options).toEqual(["", "mobile:accounts", "mobile:transactions"]);
  });

  it("shows our wording when the grant is refused", async () => {
    await mount({ onScopeWrite: () => ({ status: 409 }) });
    await userEvent.selectOptions(
      screen.getByLabelText(/^scope$/i),
      "mobile:transactions",
    );
    await userEvent.type(screen.getByLabelText(/^reason$/i), "again");
    await userEvent.click(screen.getByRole("button", { name: /^grant$/i }));
    expect(await screen.findByRole("alert")).toBeDefined();
  });
});

describe("the history", () => {
  it("shows a revoked grant, not just the live one", async () => {
    // A revoked grant is the only evidence access once existed, which is what
    // an audit asks about afterwards.
    await mount();
    const entries = screen
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(entries).toHaveLength(2);
    expect(entries.some((text) => /revoked 2026-09-28/.test(text))).toBe(true);
  });

  it("offers revoke on the live grant only", async () => {
    // Two grants in the history, one of them already revoked.
    await mount();
    expect(screen.getAllByRole("button", { name: /^revoke$/i })).toHaveLength(
      1,
    );
  });

  it("offers revoke to nobody who is not an admin", async () => {
    await mount({ roles: ["operator"] });
    expect(screen.queryByRole("button", { name: /^revoke$/i })).toBeNull();
  });

  it("revokes by scope name", async () => {
    const { calls } = await mount();
    await userEvent.click(screen.getByRole("button", { name: /^revoke$/i }));
    const removed = calls.find((call) => call.method === "DELETE");
    expect(removed?.path).toContain("/scopes/mobile%3Aaccounts");
  });
});
