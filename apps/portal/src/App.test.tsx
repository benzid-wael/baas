import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App.js";
import { ApiClient } from "./api.js";
import type { PortalConfig } from "./config.js";

/**
 * A component test, running in the ordinary suite (MP-6).
 *
 * Finding E3: the incumbent's frontend has no unit test framework at all —
 * only Playwright smokes that are not installed by default, so in practice
 * nothing runs. The framework lands with the skeleton rather than after it,
 * and it needs no browser installed and no server running.
 */
const CONFIG: PortalConfig = {
  apiBaseUrl: "https://baas.example",
  oidcIssuer: "https://idp.example",
  oidcClientId: "portal",
};

function api(status = 204): ApiClient {
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify({}), { status }),
    );
  return new ApiClient(CONFIG, fetchImpl);
}

async function signedInApi(): Promise<ApiClient> {
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ token: "s", expiresAt: "x" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
  const client = new ApiClient(CONFIG, fetchImpl);
  await client.signIn("id-token");
  return client;
}

describe("the shell", () => {
  it("asks a signed-out operator to sign in, and never for a password", () => {
    render(<App api={api()} />);
    expect(screen.getByRole("heading", { name: /sign in/i })).toBeDefined();
    // The portal performs the authorization-code flow against the identity
    // provider. A password field here would mean it had started handling
    // credentials, which it must never do.
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });

  it("shows the signed-in state once there is a session", async () => {
    render(<App api={await signedInApi()} />);
    expect(screen.getByText(/signed in/i)).toBeDefined();
  });

  it("signs out, and goes back to the sign-in prompt", async () => {
    const client = await signedInApi();
    render(<App api={client} />);

    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));

    expect(
      await screen.findByRole("heading", { name: /sign in/i }),
    ).toBeDefined();
    expect(client.signedIn).toBe(false);
  });
});
