import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App.js";
import { ApiClient } from "./api.js";
import type { FlowStore } from "./oidc.js";
import type { PortalConfig } from "./config.js";
import { instantToMillis } from "./clock.js";

/**
 * The shell, end to end within the browser (MP-6, MP-7a).
 *
 * Finding E3: the incumbent's frontend has no unit test framework — only
 * Playwright smokes that are not installed by default, so nothing runs. These
 * need no browser installed and no server running, and they exercise the whole
 * sign-in path: authorization URL, callback, token exchange, session.
 */
const CONFIG: PortalConfig = {
  apiBaseUrl: "https://baas.example",
  oidcIssuer: "https://idp.example/baas",
  oidcClientId: "baas-portal",
};

const DISCOVERY = {
  authorization_endpoint: "https://idp.example/baas/authorize",
  token_endpoint: "https://idp.example/baas/token",
};

const SYSTEM_STATE = {
  migrations: { applied: ["0001_core.sql"] },
  schema: { matches: true, undeclared: [], missing: [] },
  outbox: { unresolved: 0, depths: [] },
  inbox: { unprocessed: 0, rejectedSignatures: 0 },
  capabilities: {
    service: "baas",
    appEnv: "dev",
    tenants: ["sc"],
    providers: [],
    checkedAt: "2026-09-28T10:00:00.000Z",
  },
};

function memoryStore(initial: Record<string, string> = {}): FlowStore {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
  };
}

/** One fetch standing in for both the identity provider and the API. */
function world(overrides: { token?: unknown; system?: unknown } = {}) {
  const fetchImpl: typeof fetch = (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = url.includes("openid-configuration")
      ? DISCOVERY
      : url.endsWith("/token")
        ? (overrides.token ?? { id_token: "the-id-token" })
        : url.endsWith("/operator/sessions")
          ? { token: "sess-1", expiresAt: "2026-09-29T00:00:00.000Z" }
          : (overrides.system ?? SYSTEM_STATE);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: url.endsWith("/operator/sessions") ? 201 : 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchImpl, api: new ApiClient(CONFIG, fetchImpl) };
}

function mount(
  options: {
    search?: string;
    store?: FlowStore;
    api?: ApiClient;
    navigate?: (url: string) => void;
  } = {},
) {
  const { api, fetchImpl } = world();
  const navigate = options.navigate ?? vi.fn();
  const clearQuery = vi.fn();
  render(
    <App
      api={options.api ?? api}
      config={CONFIG}
      store={options.store ?? memoryStore()}
      location={{
        href: `https://portal.example/${options.search ?? ""}`,
        search: options.search ?? "",
      }}
      navigate={navigate}
      clearQuery={clearQuery}
      fetchImpl={fetchImpl}
    />,
  );
  return { navigate, clearQuery };
}

describe("signed out", () => {
  it("offers sign-in and never asks for a password", () => {
    mount();
    expect(screen.getByRole("heading", { name: /sign in/i })).toBeDefined();
    // The portal performs the authorization-code flow. A password field here
    // would mean it had started handling credentials, which it must never do.
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });

  it("sends the browser to the provider, with a challenge and no secret", async () => {
    const { navigate } = mount();
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalled();
    });
    const url = new URL(String(vi.mocked(navigate).mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe(DISCOVERY.authorization_endpoint);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_secret")).toBeNull();
    // The redirect URI is derived from the page, so the two halves of the
    // flow cannot disagree about it.
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://portal.example/",
    );
  });
});

describe("coming back from the provider", () => {
  const started = (): FlowStore =>
    memoryStore({
      "baas.pkce.verifier": "the-verifier",
      "baas.pkce.state": "the-state",
    });

  it("redeems the code, gets a session, and shows the console", async () => {
    mount({ search: "?code=the-code&state=the-state", store: started() });
    expect(
      await screen.findByRole("heading", { name: /system/i }),
    ).toBeDefined();
  });

  it("takes the code out of the URL", async () => {
    // A code left in the address bar is a code in history and in the next
    // screenshot.
    const { clearQuery } = mount({
      search: "?code=the-code&state=the-state",
      store: started(),
    });
    await vi.waitFor(() => {
      expect(clearQuery).toHaveBeenCalled();
    });
  });

  it("refuses a callback this tab did not start, and says so", async () => {
    mount({ search: "?code=the-code&state=somebody-elses", store: started() });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringMatching(/did not start here/),
    );
    expect(screen.getByRole("heading", { name: /sign in/i })).toBeDefined();
  });

  it("shows nothing of the provider's own error wording", async () => {
    mount({
      search: "?error=login_required&state=the-state",
      store: started(),
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("login_required");
  });
});

describe("signed in", () => {
  async function signedIn(): Promise<void> {
    mount({
      search: "?code=the-code&state=the-state",
      store: memoryStore({
        "baas.pkce.verifier": "v",
        "baas.pkce.state": "the-state",
      }),
    });
    await screen.findByRole("heading", { name: /system/i });
  }

  it("shows the system state the session fetched", async () => {
    await signedIn();
    expect(screen.getByText(/matches what this build declares/i)).toBeDefined();
  });

  it("lands on System, because it reads the API and the search screen does not", async () => {
    // A session that cannot reach the service must say so on arrival. The
    // search screen calls nothing until someone types, and would look
    // perfectly healthy against a dead API.
    await signedIn();
    expect(
      screen
        .getByRole("button", { name: /^system$/i })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("moves to the customer screen and back", async () => {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /customers/i }));
    expect(
      await screen.findByRole("heading", { name: /find a customer/i }),
    ).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: /^system$/i }));
    expect(
      await screen.findByRole("heading", { name: /^system$/i }),
    ).toBeDefined();
  });

  it("signs out and returns to the prompt", async () => {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(
      await screen.findByRole("heading", { name: /sign in/i }),
    ).toBeDefined();
  });
});

/**
 * The session countdown (MP-10, finding F1).
 *
 * "A window with an expiry must show a countdown rather than silently
 * lapsing." `expiresAt` has come back with every sign-in since MP-1 and
 * nothing read it, so a session ended mid-form and the operator found out by
 * being refused.
 */
describe("the session's remaining time", () => {
  /**
   * A fixed clock, so these assert on arithmetic rather than on how long the
   * test took. The previous version built its instants from the real clock
   * and expected "10 minutes" from an eleven-minute session, which only
   * passed because a millisecond or two elapsed in between.
   */
  const NOW = instantToMillis("2026-09-28T12:00:00.000Z");

  async function signedInWith(expiresAt: string): Promise<void> {
    const fetchImpl: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = url.endsWith("/operator/sessions")
        ? { token: "s", expiresAt, roles: ["admin"] }
        : SYSTEM_STATE;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: url.endsWith("/operator/sessions") ? 201 : 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const api = new ApiClient(CONFIG, fetchImpl);
    // Awaited: `App` decides its opening phase from `api.signedIn`, so a
    // render that races the sign-in opens signed out and the nav — which is
    // where the countdown lives — never renders at all.
    await api.signIn("id-token");
    render(
      <App
        api={api}
        config={CONFIG}
        store={memoryStore()}
        location={{ href: "https://portal.example/", search: "" }}
        navigate={vi.fn()}
        clearQuery={vi.fn()}
        fetchImpl={fetchImpl}
        now={() => NOW}
      />,
    );
  }

  it("says nothing while there is plenty of time", async () => {
    // A permanent ticking clock on a console somebody keeps open all day is
    // noise, and noise is what gets ignored when it finally matters.
    await signedInWith("2026-09-28T20:00:00.000Z");
    await vi.waitFor(() => {
      expect(screen.getByRole("heading", { name: /^system$/i })).toBeDefined();
    });
    expect(screen.queryByText(/your session ends/i)).toBeNull();
  });

  it("warns inside the last hour", async () => {
    await signedInWith("2026-09-28T12:11:00.000Z");
    expect(
      await screen.findByText(/session ends in 11 minutes/i),
    ).toBeDefined();
  });

  it("says a single minute in the singular", async () => {
    await signedInWith("2026-09-28T12:01:00.000Z");
    expect(
      await screen.findByText(/session ends in 1 minute\b/i),
    ).toBeDefined();
  });

  it("says plainly when it has already ended", async () => {
    await signedInWith("2026-09-28T11:59:00.000Z");
    expect(await screen.findByText(/session has ended/i)).toBeDefined();
  });
});
