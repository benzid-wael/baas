import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "./api.js";
import { SystemPanel } from "./system-panel.js";
import { CustomerScreen } from "./customer.js";
import { RequestLog } from "./request-log.js";
import { beginSignIn, completeSignIn } from "./oidc.js";
import type { FlowStore } from "./oidc.js";
import type { PortalConfig } from "./config.js";

/**
 * The shell (MP-6, MP-7a).
 *
 * Three states and no router: signed out, signing in, signed in. A router
 * arrives with the second screen; adding one now would be a dependency chosen
 * before there was a question for it to answer.
 *
 * **No deep links, deliberately.** A URL that identifies a customer is a URL
 * that gets pasted into a chat and lands in browser history on a shared
 * machine. MP-7b kept that decision: navigation between screens is in memory,
 * so nothing a customer can be identified by ever reaches the address bar.
 * The cost is the back button, and it is a cost worth paying here.
 */
export interface AppProps {
  readonly api: ApiClient;
  readonly config: PortalConfig;
  readonly store: FlowStore;
  /** The current location. Injected so the callback path is testable. */
  readonly location: { readonly href: string; readonly search: string };
  /** Called with where to send the browser. The one side effect. */
  readonly navigate: (url: string) => void;
  /** Called once a callback has been consumed, to take it out of the URL. */
  readonly clearQuery: () => void;
  /**
   * Used for the identity provider only — the API has its own, inside
   * `ApiClient`. Injected for the same reason: a flow that can only be
   * exercised against a real provider is a flow nobody tests.
   */
  readonly fetchImpl?: typeof fetch;
}

type Phase =
  | { readonly kind: "signed-out" }
  | { readonly kind: "working" }
  | { readonly kind: "signed-in" };

export function App(props: AppProps): React.JSX.Element {
  const { api, config, store, location, navigate, clearQuery } = props;
  const fetchImpl = props.fetchImpl;
  const [phase, setPhase] = useState<Phase>(
    api.signedIn ? { kind: "signed-in" } : { kind: "signed-out" },
  );
  const [error, setError] = useState<string | undefined>(undefined);
  /**
   * Which screen, held in memory rather than in the URL. See the note above:
   * a URL that identifies a customer is a URL that gets pasted into a chat.
   *
   * **System is the landing**, not customer search. It reads the API the
   * moment the session exists, so a session that cannot reach the service
   * says so immediately; the search screen calls nothing until someone types,
   * and would look perfectly healthy against a dead API. It is also the screen
   * an incident starts on.
   */
  const [screen, setScreen] = useState<"customers" | "requests" | "system">(
    "system",
  );

  const fail = useCallback((cause: unknown): void => {
    setError(cause instanceof Error ? cause.message : "Something went wrong.");
    setPhase({ kind: "signed-out" });
  }, []);

  // The provider redirected back. Redeem the code, exchange the identity for a
  // `baas` session, and take the code out of the URL — a code left in the
  // address bar is a code in history and in the next screenshot.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has("code") && !params.has("error")) {
      return;
    }
    setPhase({ kind: "working" });
    void completeSignIn({
      config,
      redirectUri: redirectUriOf(location.href),
      store,
      params,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    })
      .then((idToken) => api.signIn(idToken))
      .then(() => {
        setPhase({ kind: "signed-in" });
        setError(undefined);
      })
      .catch(fail)
      .finally(clearQuery);
  }, [api, config, store, location, clearQuery, fail, fetchImpl]);

  const signIn = (): void => {
    setPhase({ kind: "working" });
    void beginSignIn({
      config,
      redirectUri: redirectUriOf(location.href),
      store,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    })
      .then(navigate)
      .catch(fail);
  };

  const signOut = (): void => {
    void api
      .signOut()
      .catch(fail)
      .finally(() => {
        setPhase({ kind: "signed-out" });
      });
  };

  return (
    <main>
      <h1>baas operator console</h1>
      {error !== undefined && <p role="alert">{error}</p>}

      {phase.kind === "working" && <p>Signing in…</p>}

      {phase.kind === "signed-in" && (
        <>
          <nav aria-label="Console">
            <button
              type="button"
              onClick={() => {
                setScreen("customers");
              }}
              aria-current={screen === "customers" ? "page" : undefined}
            >
              Customers
            </button>
            <button
              type="button"
              onClick={() => {
                setScreen("requests");
              }}
              aria-current={screen === "requests" ? "page" : undefined}
            >
              Provider requests
            </button>
            <button
              type="button"
              onClick={() => {
                setScreen("system");
              }}
              aria-current={screen === "system" ? "page" : undefined}
            >
              System
            </button>
            <button type="button" onClick={signOut}>
              Sign out
            </button>
          </nav>
          {screen === "customers" && <CustomerScreen api={api} />}
          {screen === "requests" && <RequestLog api={api} />}
          {screen === "system" && <SystemPanel api={api} />}
        </>
      )}

      {phase.kind === "signed-out" && (
        <section aria-labelledby="sign-in">
          <h2 id="sign-in">Sign in</h2>
          <p>
            Sign in with your organisation account. This console never asks for
            a password.
          </p>
          <button type="button" onClick={signIn}>
            Sign in
          </button>
        </section>
      )}
    </main>
  );
}

/**
 * The redirect URI is this page without its query string.
 *
 * Derived rather than configured: it has to match byte for byte between the
 * authorization request and the token exchange, and two settings that must
 * agree are one setting that will not.
 */
function redirectUriOf(href: string): string {
  const url = new URL(href);
  url.search = "";
  url.hash = "";
  return url.toString();
}
