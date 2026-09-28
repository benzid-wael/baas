import { parse as parseLossless } from "lossless-json";
import { NO_RECORDING } from "@baas/domain";
import type {
  Clock,
  ProviderCallOutcome,
  ProviderCallRecorder,
} from "@baas/domain";
import type { RuyaConfig } from "./config.js";
import {
  RuyaApiError,
  RuyaNotConfiguredError,
  RuyaTransportError,
} from "./errors.js";

/**
 * Parse a Ruya response **without turning numbers into doubles**.
 *
 * This is the single most important line in the adapter. TCS BaNCS returns
 * monetary amounts as JSON numbers, and `JSON.parse` would hand them to us as
 * IEEE-754 doubles — silently, correctly-looking, and wrong. Every number is
 * kept as its original string, and `Money` takes it from there.
 *
 * The incumbent does the same thing, and the reason is easy to delete by
 * accident while "simplifying" a parser, so it is stated here rather than
 * implied.
 */
export function parseRuyaJson(text: string): unknown {
  return parseLossless(text, undefined, {
    parseNumber: (value: string) => value,
  });
}

export interface RuyaRequestOptions {
  /**
   * The **route**, for the request log, when the path carries an identifier.
   * See the note on Keel's equivalent: an account reference in a list column
   * is an account reference on screen, and BaNCS puts one in the path.
   */
  readonly operation?: string;
  /** The account this call is about, for the request log (MP-9). */
  readonly accountReference?: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly correlationId?: string;
  /** Off for the token call itself, which must not recurse. */
  readonly retryOnUnauthorized?: boolean;
  /**
   * The statement endpoint is Dataverse-style OData and takes none of the
   * standard BaNCS headers; sending them produces an error that mentions none
   * of them.
   */
  readonly skipStandardHeaders?: boolean;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

export class RuyaHttp {
  private token: CachedToken | undefined;

  constructor(
    private readonly config: RuyaConfig,
    private readonly clock: Clock,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Where the call is written down (MP-2). Defaulted so fixtures need none. */
    private readonly recorder: ProviderCallRecorder = NO_RECORDING,
  ) {}

  async get<T>(path: string, options: RuyaRequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  /** Forget the cached token. Used by the 401 path and by credential rotation. */
  invalidateToken(): void {
    this.token = undefined;
  }

  async accessToken(): Promise<string> {
    const now = this.clock.now().epochMilliseconds;
    const buffer = this.config.tokenRefreshBufferSeconds * 1000;
    const cached = this.token;
    if (cached !== undefined && now < cached.expiresAtMs - buffer) {
      return cached.token;
    }

    if (this.config.clientId === "" || this.config.clientSecret === "") {
      throw new RuyaNotConfiguredError("client credentials are absent");
    }

    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/token`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }).toString(),
        signal: AbortSignal.timeout(this.config.httpTimeoutMs),
      });
    } catch (error) {
      throw new RuyaTransportError(
        url,
        "could not reach the Ruya token endpoint",
        {
          cause: error,
        },
      );
    }

    if (!response.ok) {
      throw new RuyaTransportError(
        url,
        `Ruya token endpoint returned ${response.status.toString()}`,
      );
    }

    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (body.access_token === undefined || body.access_token === "") {
      throw new RuyaTransportError(
        url,
        "Ruya token endpoint returned no access_token",
      );
    }

    this.token = {
      token: body.access_token,
      expiresAtMs: now + Math.max(body.expires_in ?? 3600, 60) * 1000,
    };
    return this.token.token;
  }

  private async request<T>(
    method: "GET",
    path: string,
    options: RuyaRequestOptions,
  ): Promise<T> {
    let refreshed = false;

    // **One row per attempt**, not one per call. A request that succeeded on
    // its third try after two 500s is a different thing from one that
    // succeeded immediately, and only the operator reading this table can
    // decide whether that matters.
    for (let attempt = 0; ; attempt += 1) {
      const url = this.buildUrl(path, options);
      const startedAt = this.clock.now();
      const operation = options.operation ?? `${method} ${path}`;
      let outcome: ProviderCallOutcome = "unreachable";
      let responseStatus: number | undefined;
      let responseBody = "";
      let errorMessage: string | undefined;
      let response: Response;

      try {
        try {
          response = await this.fetchImpl(url, {
            method,
            headers: await this.headers(options),
            signal: AbortSignal.timeout(this.config.httpTimeoutMs),
          });
        } catch (error) {
          errorMessage =
            error instanceof Error
              ? error.message
              : "unknown transport failure";
          if (attempt < this.config.maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          throw new RuyaTransportError(
            operation,
            `could not reach Ruya: ${errorMessage}`,
            { cause: error },
          );
        }

        responseStatus = response.status;

        // A 401 usually means the token expired sooner than it said it would.
        // Invalidating and retrying **once** is carried over from the
        // incumbent; retrying repeatedly would turn a revoked credential into
        // a hot loop against the token endpoint.
        if (
          response.status === 401 &&
          !refreshed &&
          options.retryOnUnauthorized !== false
        ) {
          this.invalidateToken();
          refreshed = true;
          outcome = "rejected";
          continue;
        }

        const text = await response.text();
        responseBody = text;

        if (response.status >= 500 && attempt < this.config.maxRetries) {
          outcome = "rejected";
          await this.backoff(attempt);
          continue;
        }

        if (!response.ok) {
          outcome = "rejected";
          throw new RuyaApiError(
            response.status,
            operation,
            text === "" ? null : parseRuyaJson(text),
            `Ruya answered ${response.status.toString()} for ${operation}`,
          );
        }

        outcome = "ok";
        return (text === "" ? null : parseRuyaJson(text)) as T;
      } finally {
        // In a `finally` so that every way out of an attempt — answered,
        // refused, retried or unreachable — leaves a row. Recording at each
        // exit would miss one the first time a branch was added, and this
        // method has five.
        await this.recorder.record({
          providerId: "ruya",
          operation,
          correlationId: options.correlationId,
          accountReference: options.accountReference,
          outcome,
          responseStatus,
          // A GET, so there is no request body. Kept as a column rather than
          // made nullable: a POST will have one, and a schema that has to
          // change for that is a schema that will not.
          requestBody: "",
          responseBody,
          errorMessage,
          startedAt,
          durationMs:
            this.clock.now().epochMilliseconds - startedAt.epochMilliseconds,
        });
      }
    }
  }

  private buildUrl(path: string, options: RuyaRequestOptions): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * TCS BaNCS requires `entity`, `languageCode`, `userId` and `channelId` on
   * every call. Omitting one produces an error that names none of them.
   */
  private async headers(
    options: RuyaRequestOptions,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.skipStandardHeaders === true
        ? {}
        : {
            entity: this.config.entity,
            languageCode: String(this.config.languageCode),
            userId: String(this.config.userId),
            channelId: String(this.config.channelId),
          }),
    };
    if (options.correlationId !== undefined) {
      headers["X-Request-Id"] = options.correlationId;
    }
    return headers;
  }

  private backoff(attempt: number): Promise<void> {
    const delay = Math.min(250 * 2 ** attempt, 4_000);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}
