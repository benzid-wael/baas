import { useState } from "react";
import type { ApiClient } from "./api.js";

/**
 * The shell (MP-6).
 *
 * Deliberately almost nothing: a signed-out state, a signed-in state, and the
 * seam the screens plug into. MP-7 to MP-10 fill it. What matters here is that
 * the shape is right — a session that lives in memory, an error surface that
 * shows our words, and a test that runs without a browser being installed.
 */
export interface AppProps {
  readonly api: ApiClient;
}

export function App({ api }: AppProps): React.JSX.Element {
  const [signedIn, setSignedIn] = useState(api.signedIn);
  const [error, setError] = useState<string | undefined>(undefined);

  const signOut = (): void => {
    void api
      .signOut()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Sign-out failed.");
      })
      .finally(() => {
        setSignedIn(api.signedIn);
      });
  };

  return (
    <main>
      <h1>baas operator console</h1>
      {error !== undefined && <p role="alert">{error}</p>}
      {signedIn ? (
        <>
          <p>Signed in.</p>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </>
      ) : (
        <SignInPrompt />
      )}
    </main>
  );
}

/**
 * The portal performs the authorization-code flow with PKCE against the
 * identity provider itself and posts the resulting token to `baas`. It never
 * holds a client secret, because a browser cannot hold one.
 *
 * The flow itself arrives with MP-7; this states the shape so that nobody
 * builds a password form here in the meantime.
 */
function SignInPrompt(): React.JSX.Element {
  return (
    <section aria-labelledby="sign-in">
      <h2 id="sign-in">Sign in</h2>
      <p>
        Sign in with your organisation account. This console never asks for a
        password.
      </p>
    </section>
  );
}
