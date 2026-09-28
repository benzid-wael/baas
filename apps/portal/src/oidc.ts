import { createPkce, createState } from "./pkce.js";
import type { PortalConfig } from "./config.js";

/**
 * The authorization-code flow with PKCE (MP-7a).
 *
 * The portal talks to the identity provider **itself** and posts the resulting
 * ID token to `baas`, which verifies it and issues a session of its own. `baas`
 * never holds a client secret and never proxies the provider — that split is
 * what lets the console be a static bundle.
 *
 * Endpoints come from discovery rather than being built from the issuer. The
 * guess (`{issuer}/authorize`) is right for the development provider and wrong
 * for several real ones, and finding out in stage is the expensive way.
 */
export interface OidcEndpoints {
  readonly authorization: string;
  readonly token: string;
}

export class OidcError extends Error {
  readonly code = "portal.oidc.failed";

  constructor(message: string) {
    super(message);
    this.name = "OidcError";
  }
}

/** Where the verifier and state live across the redirect. See the note below. */
export interface FlowStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const VERIFIER_KEY = "baas.pkce.verifier";
const STATE_KEY = "baas.pkce.state";

/**
 * `sessionStorage`, and only for these two values.
 *
 * The session token deliberately never goes here — a credential that reads any
 * customer in the tenant must not outlive the tab, and any script on the origin
 * can read storage. The verifier is different in kind: it is single-use, it is
 * worthless without the matching code, it is discarded the moment the code is
 * redeemed, and it **has** to survive a full page load because the flow leaves
 * the site and comes back.
 */
export function browserFlowStore(): FlowStore {
  return {
    get: (key) => globalThis.sessionStorage.getItem(key),
    set: (key, value) => {
      globalThis.sessionStorage.setItem(key, value);
    },
    remove: (key) => {
      globalThis.sessionStorage.removeItem(key);
    },
  };
}

interface DiscoveryDocument {
  readonly authorization_endpoint?: unknown;
  readonly token_endpoint?: unknown;
}

export async function discover(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcEndpoints> {
  const response = await fetchImpl(
    `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
  );
  if (!response.ok) {
    throw new OidcError("The identity provider could not be reached.");
  }
  const document = (await response.json()) as DiscoveryDocument;
  const authorization = document.authorization_endpoint;
  const token = document.token_endpoint;
  if (typeof authorization !== "string" || typeof token !== "string") {
    throw new OidcError("The identity provider's configuration is incomplete.");
  }
  return { authorization, token };
}

export interface BeginOptions {
  readonly config: PortalConfig;
  readonly redirectUri: string;
  readonly store: FlowStore;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Start the flow: mint a verifier, remember it, and return where to send the
 * browser. Returning the URL rather than navigating keeps this testable and
 * leaves the one side effect — the redirect — at the call site.
 */
export async function beginSignIn(options: BeginOptions): Promise<string> {
  const endpoints = await discover(
    options.config.oidcIssuer,
    options.fetchImpl ?? fetch,
  );
  const pkce = await createPkce();
  const state = createState();

  options.store.set(VERIFIER_KEY, pkce.verifier);
  options.store.set(STATE_KEY, state);

  const url = new URL(endpoints.authorization);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.config.oidcClientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method);
  return url.toString();
}

export interface CompleteOptions {
  readonly config: PortalConfig;
  readonly redirectUri: string;
  readonly store: FlowStore;
  /** The query string the provider redirected back with. */
  readonly params: URLSearchParams;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Finish the flow and return the ID token, which is the only part `baas` wants.
 *
 * The access token is deliberately discarded: the portal calls no provider API,
 * so holding one would be a credential kept for no purpose.
 */
export async function completeSignIn(
  options: CompleteOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const expectedState = options.store.get(STATE_KEY);
  const verifier = options.store.get(VERIFIER_KEY);

  // Cleared before anything can go wrong with the exchange. A verifier that
  // survives a failed attempt is a verifier available for a second one.
  options.store.remove(STATE_KEY);
  options.store.remove(VERIFIER_KEY);

  const error = options.params.get("error");
  if (error !== null) {
    // The provider's own error code is not shown: it is not written for a
    // person, and `login_required` on a screen helps nobody.
    throw new OidcError("Sign-in was not completed.");
  }

  const state = options.params.get("state");
  const code = options.params.get("code");
  if (expectedState === null || verifier === null) {
    throw new OidcError("This sign-in did not start here. Try again.");
  }
  if (state !== expectedState) {
    // Someone delivered a code to this redirect that this tab did not ask for.
    throw new OidcError("This sign-in did not start here. Try again.");
  }
  if (code === null || code === "") {
    throw new OidcError("Sign-in was not completed.");
  }

  const endpoints = await discover(options.config.oidcIssuer, fetchImpl);
  const response = await fetchImpl(endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: options.redirectUri,
      client_id: options.config.oidcClientId,
      code_verifier: verifier,
    }).toString(),
  });

  if (!response.ok) {
    throw new OidcError("Sign-in was not completed.");
  }
  const body = (await response.json()) as { id_token?: unknown };
  if (typeof body.id_token !== "string" || body.id_token === "") {
    throw new OidcError("The identity provider returned no identity.");
  }
  return body.id_token;
}
