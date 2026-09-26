/**
 * The domain error taxonomy is closed: every error carries a stable,
 * machine-readable `code` that transport maps once (RFC-BaaS §5.11).
 * Message text is for humans and may change; `code` may not.
 *
 * T2 extends this taxonomy. T1 declares only what `Money` and the identifier
 * constructors need, so that the first domain type can fail in a typed way.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnknownCurrencyError extends DomainError {
  readonly code = "domain.currency.unknown";

  constructor(readonly currency: string) {
    super(`Unknown currency code: ${currency}`);
  }
}

export class InvalidAmountError extends DomainError {
  readonly code = "domain.money.invalid_amount";

  constructor(
    readonly amount: string,
    readonly currency: string,
  ) {
    super(`Not a valid ${currency} amount: ${JSON.stringify(amount)}`);
  }
}

export class AmountPrecisionError extends DomainError {
  readonly code = "domain.money.precision";

  constructor(
    readonly amount: string,
    readonly currency: string,
    readonly scale: number,
  ) {
    super(
      `${JSON.stringify(amount)} carries more precision than ${currency} ` +
        `permits (${scale.toString()} decimal places)`,
    );
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "domain.money.currency_mismatch";

  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(`Cannot combine ${left} with ${right}`);
  }
}

export class InvalidDurationError extends DomainError {
  readonly code = "domain.duration.invalid";

  constructor(readonly value: number) {
    super(`Not a valid duration in milliseconds: ${String(value)}`);
  }
}

export class InvalidInstantError extends DomainError {
  readonly code = "domain.instant.invalid";

  constructor(readonly value: number) {
    super(`Not a valid instant in epoch milliseconds: ${String(value)}`);
  }
}

export class InvalidIdentifierError extends DomainError {
  readonly code = "domain.identifier.invalid";

  constructor(
    readonly kind: string,
    readonly value: string,
  ) {
    super(`Not a valid ${kind}: ${JSON.stringify(value)}`);
  }
}
