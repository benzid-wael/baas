/**
 * PKCE, because the portal is a public client (MP-7a).
 *
 * A browser cannot keep a secret, so the authorization code flow alone is not
 * enough: anyone who intercepts the code can redeem it. PKCE binds the
 * redemption to a one-time verifier this tab generated and never sent, so an
 * intercepted code is worth nothing without it.
 *
 * `crypto.subtle`, not a library and not `node:crypto` — the boundary gate
 * refuses the latter outright, and this is exactly the code that would have
 * reached for it.
 */

/** RFC 7636 puts the verifier between 43 and 128 characters. 32 bytes gives 43. */
const VERIFIER_BYTES = 32;

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

export async function createPkce(
  random: Crypto = globalThis.crypto,
): Promise<Pkce> {
  const verifier = randomUrlSafe(VERIFIER_BYTES, random);
  const digest = await random.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return {
    verifier,
    challenge: base64Url(new Uint8Array(digest)),
    // Only S256. `plain` is in the specification and is no protection at all;
    // offering it would mean an identity provider could negotiate it away.
    method: "S256",
  };
}

/**
 * A value the authorization server echoes back, so a response that was not
 * asked for is refused. Without it, anyone can deliver a code to this
 * redirect and have the tab redeem it.
 */
export function createState(random: Crypto = globalThis.crypto): string {
  return randomUrlSafe(VERIFIER_BYTES, random);
}

function randomUrlSafe(bytes: number, random: Crypto): string {
  return base64Url(random.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Base64url without padding, as the specification requires.
 *
 * `btoa` rather than Buffer: there is no Buffer in a browser, and reaching for
 * one is how a Node polyfill ends up in the bundle.
 */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
