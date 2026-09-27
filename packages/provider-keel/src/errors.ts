/**
 * Keel's error shapes, carried over from the incumbent unchanged.
 *
 * The distinction matters and is worth keeping: an **API** error means Keel
 * answered and said no, and a **transport** error means we do not know whether
 * it acted. The dispatcher treats those differently — one is terminal, the
 * other is `unknown` and belongs to the reconciler (finding A7) — so
 * collapsing them into one error type would erase the difference at exactly
 * the point it is needed.
 */
export class KeelApiError extends Error {
  readonly code = "provider.keel.api";

  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly responseBody: unknown,
    message: string,
    readonly idempotencyId?: string,
  ) {
    super(message);
    this.name = "KeelApiError";
  }
}

export class KeelTransportError extends Error {
  readonly code = "provider.keel.transport";

  constructor(
    readonly endpoint: string,
    message: string,
    options?: ErrorOptions,
    readonly idempotencyId?: string,
  ) {
    super(message, options);
    this.name = "KeelTransportError";
  }
}

export class KeelNotConfiguredError extends Error {
  readonly code = "provider.keel.not_configured";

  constructor(what: string) {
    super(`Keel is not configured: ${what}`);
    this.name = "KeelNotConfiguredError";
  }
}
