import { randomUUID } from "node:crypto";
import type { KeelAccessTokens } from "./access-token.js";
import type { KeelConfig } from "./config.js";
import { KeelApiError, KeelTransportError } from "./errors.js";
import { signKeelRequest } from "./signing.js";

export interface KeelRequestOptions {
  readonly idempotencyId?: string;
  readonly correlationId?: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
}

/**
 * The Keel transport.
 *
 * Adapted rather than lifted: the incumbent's `KeelHttpService` is the most
 * portable file in its provider layer and it still could not be copied. It is
 * a Nest `@Injectable` over `@nestjs/axios`, and it reaches into a runtime
 * configuration service to resolve its own settings on every call. What
 * transfers is the **protocol** — the header set, the signing rule, the
 * GET-is-unsigned rule, the error split — which is the part whose value is in
 * having been learned from a partner rather than read from a document.
 *
 * `fetch` rather than axios: one fewer dependency in a package whose whole job
 * is to be thin, and Node has had it natively for several majors.
 */
export class KeelHttp {
  constructor(
    private readonly config: KeelConfig,
    private readonly tokens: KeelAccessTokens,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get<T>(path: string, options: KeelRequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, undefined, options);
  }

  post<T>(
    path: string,
    body: unknown,
    options: KeelRequestOptions = {},
  ): Promise<T> {
    return this.request<T>("POST", path, body, options);
  }

  /**
   * Build the headers for a request.
   *
   * A **GET is never signed and carries no idempotency id** — Keel rejects a
   * signed GET, and sending one produces a `400` whose message says nothing
   * about signatures. That asymmetry is the single most useful thing in this
   * file.
   */
  async headersFor(
    method: string,
    rawBody: string,
    options: KeelRequestOptions,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.tokens.bearerToken(this.config)}`,
      Accept: "application/json",
    };

    if (options.correlationId !== undefined) {
      headers["X-Request-Id"] = options.correlationId;
    }

    if (method !== "GET") {
      const idempotencyId = options.idempotencyId ?? randomUUID();
      headers["Content-Type"] = "application/json";
      headers["X-Idempotency-Id"] = idempotencyId;
      headers["X-Digital-Signature"] = signKeelRequest(
        rawBody,
        idempotencyId,
        this.config.signingPrivateKeyPem,
      );
    }

    return headers;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    options: KeelRequestOptions,
  ): Promise<T> {
    const url = new URL(
      path.replace(/^\/+/, ""),
      `${this.config.baseUrl.replace(/\/+$/, "")}/`,
    );
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const rawBody = body === undefined ? "" : JSON.stringify(body);
    const headers = await this.headersFor(method, rawBody, options);
    const endpoint = `${method} ${url.pathname}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: rawBody }),
        signal: AbortSignal.timeout(this.config.httpTimeoutMs),
      });
    } catch (error) {
      // We do not know whether Keel acted. That distinction is the whole
      // reason this is a different error type from the one below.
      throw new KeelTransportError(
        endpoint,
        `could not reach Keel: ${error instanceof Error ? error.message : "unknown"}`,
        { cause: error },
        options.idempotencyId,
      );
    }

    const text = await response.text();
    const parsed: unknown = text === "" ? null : safeJson(text);

    if (!response.ok) {
      throw new KeelApiError(
        response.status,
        endpoint,
        parsed,
        `Keel answered ${response.status.toString()} for ${endpoint}`,
        options.idempotencyId,
      );
    }

    return parsed as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // A non-JSON body from a JSON API is evidence, not a parse failure to
    // discard — it is usually a gateway page, and keeping it is how that gets
    // diagnosed.
    return { raw: text };
  }
}
