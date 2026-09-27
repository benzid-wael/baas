import {
  createHmac,
  createVerify,
  constants,
  timingSafeEqual,
} from "node:crypto";
import type { InboundEventShape, WebhookVerifier } from "@baas/domain";
import type { Logger } from "@baas/platform";
import type { ProviderCredentials } from "@baas/platform";
import { describeError } from "@baas/platform";

/**
 * Verifying inbound provider callbacks (New-21).
 *
 * **Lifted, not designed.** Both schemes are taken from the incumbent's
 * verifiers — `keel-signature.service.ts` and `callback.controller.ts` — and
 * an earlier draft of this task wrongly claimed no scheme existed (correction
 * C11). The value in these rules is that they were learned from a partner, so
 * the only defensible source for them is the code that already talks to one.
 *
 * Three rules hold for every provider here:
 *
 * 1. **Fail closed.** No signature, no credential, an unparseable key, an
 *    unknown provider — all `false`. There is no configuration that turns
 *    verification off, because the incumbent had one (its finding C3) and it
 *    meant a missing secret silently accepted everything.
 * 2. **The raw bytes, never a re-serialisation.** Both partners sign the exact
 *    body. This function is handed those bytes and never a parsed object.
 * 3. **Constant-time comparison** for the HMAC scheme. RSA verification is
 *    already constant-time with respect to the signature.
 */
export const KEEL_SIGNATURE_HEADER = "x-digital-signature";
export const KEEL_NOTIFICATION_ID_HEADER = "x-webhook-notification-id";
export const RUYA_SIGNATURE_HEADER = "x-ruya-callback-signature";

/**
 * Printable ASCII, bounded — the incumbent's own rule for the Keel
 * notification id, kept because this value reaches a log line and a database
 * column and is entirely attacker-controlled.
 */
const NOTIFICATION_ID = /^[\x21-\x7e]{1,80}$/;

interface ProviderWebhookScheme {
  /** True when this deployment holds what it needs to verify at all. */
  configured(credentials: ProviderCredentials): boolean;
  verify(
    credentials: ProviderCredentials,
    rawBody: string,
    headers: Readonly<Record<string, string | undefined>>,
  ): boolean;
  externalEventId(
    payload: Readonly<Record<string, unknown>>,
    headers: Readonly<Record<string, string | undefined>>,
  ): string | null;
}

const SCHEMES: Readonly<Record<string, ProviderWebhookScheme>> = {
  /**
   * Keel: base64 RSA-SHA256, PKCS#1 v1.5, over the raw body **alone**.
   *
   * Note the asymmetry with the outbound direction, which signs
   * `${rawBody}${idempotencyId}`. Carrying the id into inbound verification
   * fails every genuine callback, and the failure looks like a key problem.
   */
  keel: {
    configured: (credentials) => credentials.webhookPublicKeyPem !== undefined,
    verify(credentials, rawBody, headers) {
      const key = credentials.webhookPublicKeyPem;
      const signature = headers[KEEL_SIGNATURE_HEADER];
      if (key === undefined || signature === undefined || signature === "") {
        return false;
      }
      const verifier = createVerify("RSA-SHA256");
      verifier.update(rawBody);
      verifier.end();
      return verifier.verify(
        { key, padding: constants.RSA_PKCS1_PADDING },
        signature,
        "base64",
      );
    },
    externalEventId(payload, headers) {
      // The header is the partner's contract. The payload's own id is a
      // fallback, because the simulator sends one and a partner that omits the
      // header should still be deduplicated rather than replayed.
      const header = headers[KEEL_NOTIFICATION_ID_HEADER];
      if (header !== undefined && NOTIFICATION_ID.test(header)) {
        return header;
      }
      return stringField(payload, "eventId");
    },
  },

  /**
   * Ruya (TCS BaNCS): hex HMAC-SHA256 over the raw body, with an optional
   * `sha256=` prefix.
   *
   * The incumbent also accepts a bare `x-signature` header. That is not
   * carried here: it is a second accepted name with no stated reason, and
   * every accepted header name is a surface. See the open question in New-21.
   */
  ruya: {
    configured: (credentials) => credentials.callbackHmacSecret !== undefined,
    verify(credentials, rawBody, headers) {
      const secret = credentials.callbackHmacSecret;
      if (secret === undefined) {
        return false;
      }
      const expected = createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");
      return matchesHex(headers[RUYA_SIGNATURE_HEADER], expected);
    },
    externalEventId: (payload) => stringField(payload, "eventId"),
  },
};

export interface WebhookVerifierOptions {
  /** This deployment's providers, by id. */
  readonly providers: Readonly<Record<string, ProviderCredentials>>;
  /** One tenant today; the tenant every configured provider belongs to. */
  readonly tenantId: string;
  readonly logger: Logger;
}

export function buildWebhookVerifier(
  options: WebhookVerifierOptions,
): WebhookVerifier {
  return {
    tenantFor(providerId) {
      // A provider we hold no credentials for is not ours, whatever it claims.
      return options.providers[providerId] === undefined
        ? undefined
        : options.tenantId;
    },

    verify(providerId, rawBody, headers) {
      const credentials = options.providers[providerId];
      const scheme = SCHEMES[providerId];
      if (credentials === undefined || scheme === undefined) {
        return false;
      }
      if (!scheme.configured(credentials)) {
        // Deliberately not an exception. The delivery is still recorded, with
        // `signature_verified = false`, so a missing credential shows up as
        // rejected traffic rather than as silence — and cannot be mistaken for
        // a partner that has stopped sending.
        options.logger.error(
          { providerId },
          "no callback credential for this provider; deliveries cannot be verified",
        );
        return false;
      }
      try {
        return scheme.verify(credentials, rawBody, headers);
      } catch (error) {
        // A malformed key or signature must fail closed rather than propagate.
        options.logger.warn(
          { providerId, err: describeError(error) },
          "callback signature could not be checked",
        );
        return false;
      }
    },

    interpret(providerId, payload, headers): InboundEventShape {
      const object = isObject(payload) ? payload : {};
      const scheme = SCHEMES[providerId];
      return {
        externalEventId:
          scheme === undefined ? null : scheme.externalEventId(object, headers),
        eventType: stringField(object, "eventType"),
        providerRef: stringField(object, "reference"),
      };
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  object: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = object[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Compare a presented hex signature with the expected one, in constant time.
 *
 * Normalised first — trimmed, an optional `sha256=` prefix removed, lowercased
 * — and then required to be hex, because `timingSafeEqual` throws on differing
 * lengths and a length check on unvalidated input is itself a leak of length.
 */
function matchesHex(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) {
    return false;
  }
  const normalised = presented
    .trim()
    .replace(/^sha256=/i, "")
    .toLowerCase();
  if (
    !/^[a-f0-9]+$/.test(normalised) ||
    normalised.length !== expected.length
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(normalised), Buffer.from(expected));
}
