/**
 * Ruya's error shapes. The same split as Keel, for the same reason: an API
 * error means the bank answered and said no; a transport error means we do
 * not know whether it acted.
 */
export class RuyaApiError extends Error {
  readonly code = "provider.ruya.api";
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly responseBody: unknown,
    message: string,
  ) {
    super(message);
    this.name = "RuyaApiError";
  }
}

export class RuyaTransportError extends Error {
  readonly code = "provider.ruya.transport";
  constructor(
    readonly endpoint: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuyaTransportError";
  }
}

export class RuyaNotConfiguredError extends Error {
  readonly code = "provider.ruya.not_configured";
  constructor(what: string) {
    super(`Ruya is not configured: ${what}`);
    this.name = "RuyaNotConfiguredError";
  }
}
