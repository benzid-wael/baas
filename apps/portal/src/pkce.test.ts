import { describe, expect, it } from "vitest";
import { createPkce, createState } from "./pkce.js";

/**
 * Every byte the same, so the challenge is reproducible.
 *
 * Built rather than spread from the real `Crypto`: spreading a class instance
 * loses its prototype, and the result would be a plain object that happens to
 * type-check.
 */
function fixedRandom(byte: number): Crypto {
  const stub: Pick<Crypto, "getRandomValues" | "subtle"> = {
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) {
        array.fill(byte);
      }
      return array;
    },
    subtle: globalThis.crypto.subtle,
  };
  return stub as Crypto;
}

describe("the PKCE challenge", () => {
  it("produces a verifier the specification accepts", async () => {
    const { verifier } = await createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    // Base64url, unpadded: the unreserved set RFC 7636 allows.
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("offers S256 and nothing else", async () => {
    // `plain` is in the specification and is no protection at all. Not
    // offering it means an identity provider cannot negotiate it away.
    expect((await createPkce()).method).toBe("S256");
  });

  it("derives the challenge from the verifier, by SHA-256", async () => {
    const { verifier, challenge } = await createPkce();
    const expected = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    expect(challenge).toBe(
      btoa(String.fromCharCode(...new Uint8Array(expected)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    );
  });

  it("is reproducible for a given verifier, and different for different ones", async () => {
    const one = await createPkce(fixedRandom(1));
    const same = await createPkce(fixedRandom(1));
    const other = await createPkce(fixedRandom(2));
    expect(one.challenge).toBe(same.challenge);
    expect(one.challenge).not.toBe(other.challenge);
  });

  it("never pads the challenge", async () => {
    // A padded challenge is a rejected challenge, and the rejection says
    // "invalid_grant", which points at everything except the padding.
    expect((await createPkce()).challenge).not.toContain("=");
  });

  it("uses fresh randomness each time", async () => {
    const first = await createPkce();
    const second = await createPkce();
    expect(first.verifier).not.toBe(second.verifier);
  });
});

describe("the state parameter", () => {
  it("is long, url-safe and fresh", () => {
    const state = createState();
    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(state).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(createState()).not.toBe(state);
  });
});
