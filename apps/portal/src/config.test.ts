import { describe, expect, it } from "vitest";
import { PortalConfigError, readConfig } from "./config.js";

describe("reading the build's configuration", () => {
  it("reads what the bundler injected", () => {
    expect(
      readConfig({
        VITE_API_BASE_URL: "https://baas.example/",
        VITE_OIDC_ISSUER: "https://idp.example",
        VITE_OIDC_CLIENT_ID: "portal",
      }),
    ).toEqual({
      // The trailing slash is removed once, here, so that no call site has to
      // remember whether to add one.
      apiBaseUrl: "https://baas.example",
      oidcIssuer: "https://idp.example",
      oidcClientId: "portal",
    });
  });

  it("reports every missing value at once, not the first", () => {
    // The same rule the service's loader follows: a deployment that learns one
    // rule per rebuild rebuilds six times.
    try {
      readConfig({});
      throw new Error("expected readConfig to refuse an empty environment");
    } catch (error) {
      expect(error).toBeInstanceOf(PortalConfigError);
      expect((error as Error).message).toContain("VITE_API_BASE_URL");
      expect((error as Error).message).toContain("VITE_OIDC_ISSUER");
      expect((error as Error).message).toContain("VITE_OIDC_CLIENT_ID");
    }
  });

  it("treats an empty string as missing", () => {
    expect(() => readConfig({ VITE_API_BASE_URL: "" })).toThrow(
      PortalConfigError,
    );
  });
});
