/**
 * Where the API is, and nothing else.
 *
 * **The portal holds no secret.** It runs in a browser, so anything it knows
 * is public: a bundled client secret is a published client secret. Its only
 * credential is the operator session it exchanges an identity-provider token
 * for, and that lives in memory for the life of the tab.
 *
 * `import.meta.env` rather than `process.env`, because there is no process.
 * The tsconfig omits Node's types precisely so that reaching for one is a type
 * error here rather than a runtime surprise in a browser.
 */
export interface PortalConfig {
  readonly apiBaseUrl: string;
  readonly oidcIssuer: string;
  readonly oidcClientId: string;
}

interface ViteEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_OIDC_ISSUER?: string;
  readonly VITE_OIDC_CLIENT_ID?: string;
}

export class PortalConfigError extends Error {
  readonly code = "portal.config.invalid";

  constructor(missing: readonly string[]) {
    super(
      `The portal is not configured. Missing: ${missing.join(", ")}. These are build-time values; rebuild the bundle rather than editing it.`,
    );
    this.name = "PortalConfigError";
  }
}

/**
 * Read the build's configuration, or say everything that is missing.
 *
 * The same rule the service's loader follows: every problem at once, not the
 * first one. A deployment that learns one rule per rebuild is a deployment
 * that rebuilds six times.
 */
export function readConfig(env: ViteEnv): PortalConfig {
  const missing: string[] = [];
  const required = (name: keyof ViteEnv): string => {
    const value = env[name];
    if (value === undefined || value === "") {
      missing.push(name);
      return "";
    }
    return value;
  };

  const config = {
    apiBaseUrl: stripTrailingSlash(required("VITE_API_BASE_URL")),
    oidcIssuer: required("VITE_OIDC_ISSUER"),
    oidcClientId: required("VITE_OIDC_CLIENT_ID"),
  };

  if (missing.length > 0) {
    throw new PortalConfigError(missing);
  }
  return config;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
