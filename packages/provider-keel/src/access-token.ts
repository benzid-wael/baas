import { createHash } from "node:crypto";
import type { Clock } from "@baas/domain";
import type { KeelConfig } from "./config.js";
import { keelOauthScope } from "./config.js";
import { KeelNotConfiguredError, KeelTransportError } from "./errors.js";

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
  readonly configKey: string;
}

/**
 * OAuth client-credentials tokens, cached and de-duplicated.
 *
 * Two behaviours lifted from the incumbent because both were learned the hard
 * way:
 *
 * - **A 60-second safety margin** on expiry. A token that expires mid-flight
 *   fails a call that looked fine when it started.
 * - **In-flight de-duplication.** Without it, a cold start with N concurrent
 *   requests fetches N tokens, and some providers rate-limit the token
 *   endpoint far more aggressively than the API.
 *
 * The cache is keyed on a hash of the credentials, so rotating them
 * invalidates it rather than serving a token minted for the old client.
 */
export class KeelAccessTokens {
  private cached: CachedToken | undefined;
  private inFlight: { configKey: string; promise: Promise<string> } | undefined;

  constructor(
    private readonly clock: Clock,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async bearerToken(config: KeelConfig): Promise<string> {
    if (config.bearerToken !== undefined && config.bearerToken !== "") {
      return config.bearerToken;
    }

    const configKey = createHash("sha256")
      .update(
        JSON.stringify([
          config.clientId,
          config.clientSecret,
          config.accessTokenEndpoint,
          keelOauthScope(config.baseUrl),
        ]),
      )
      .digest("hex");

    const now = this.clock.now().epochMilliseconds;
    const cached = this.cached;
    if (cached?.configKey === configKey && cached.expiresAtMs - 60_000 > now) {
      return cached.token;
    }

    const inFlight = this.inFlight;
    if (inFlight?.configKey === configKey) {
      return inFlight.promise;
    }

    const pending = {
      configKey,
      promise: this.fetchToken(config)
        .then((token) => {
          if (this.inFlight === pending) {
            this.cached = { ...token, configKey };
          }
          return token.token;
        })
        .finally(() => {
          if (this.inFlight === pending) {
            this.inFlight = undefined;
          }
        }),
    };
    this.inFlight = pending;
    return pending.promise;
  }

  private async fetchToken(
    config: KeelConfig,
  ): Promise<{ token: string; expiresAtMs: number }> {
    if (
      config.clientId === "" ||
      config.clientSecret === "" ||
      config.accessTokenEndpoint === ""
    ) {
      throw new KeelNotConfiguredError("OAuth credentials are absent");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(config.accessTokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          scope: keelOauthScope(config.baseUrl),
        }).toString(),
        signal: AbortSignal.timeout(config.httpTimeoutMs),
      });
    } catch (error) {
      throw new KeelTransportError(
        config.accessTokenEndpoint,
        "could not reach the Keel token endpoint",
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new KeelTransportError(
        config.accessTokenEndpoint,
        `Keel token endpoint returned ${response.status.toString()}`,
      );
    }

    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (body.access_token === undefined || body.access_token === "") {
      throw new KeelTransportError(
        config.accessTokenEndpoint,
        "Keel token endpoint returned no access_token",
      );
    }

    const expiresIn = Math.max(body.expires_in ?? 3600, 60);
    return {
      token: body.access_token,
      expiresAtMs: this.clock.now().epochMilliseconds + expiresIn * 1000,
    };
  }
}
