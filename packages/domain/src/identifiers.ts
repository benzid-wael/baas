import { InvalidIdentifierError } from "./errors.js";

declare const brand: unique symbol;

/**
 * A nominal type over a primitive. Compile-time only: a `CustomerId` cannot be
 * passed where an `AccountId` is expected, which is the class of defect that a
 * service passing bare strings between 34 modules cannot otherwise prevent.
 */
export type Branded<T, B extends string> = T & { readonly [brand]: B };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Lower-case slug: a provider or operation name, stable and human-authored. */
const SLUG = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/;

const SLUG_MAX_LENGTH = 64;

function uuidConstructor<B extends string>(
  kind: B,
): (value: string) => Branded<string, B> {
  return (value: string): Branded<string, B> => {
    if (!UUID.test(value)) {
      throw new InvalidIdentifierError(kind, value);
    }
    return value.toLowerCase() as Branded<string, B>;
  };
}

function slugConstructor<B extends string>(
  kind: B,
): (value: string) => Branded<string, B> {
  return (value: string): Branded<string, B> => {
    if (value.length > SLUG_MAX_LENGTH || !SLUG.test(value)) {
      throw new InvalidIdentifierError(kind, value);
    }
    return value as Branded<string, B>;
  };
}

export type TenantId = Branded<string, "TenantId">;
export type CustomerId = Branded<string, "CustomerId">;
export type AccountId = Branded<string, "AccountId">;
export type BeneficiaryId = Branded<string, "BeneficiaryId">;
export type InstructionId = Branded<string, "InstructionId">;
export type PaymentOrderId = Branded<string, "PaymentOrderId">;
/** Also the provider idempotency key, so a retry is the same operation. */
export type EffectId = Branded<string, "EffectId">;
export type ActorId = Branded<string, "ActorId">;
export type ApiClientId = Branded<string, "ApiClientId">;
export type CorridorId = Branded<string, "CorridorId">;
export type RuleId = Branded<string, "RuleId">;

export type ProviderId = Branded<string, "ProviderId">;
export type OperationId = Branded<string, "OperationId">;

export const tenantId = uuidConstructor("TenantId");
export const customerId = uuidConstructor("CustomerId");
export const accountId = uuidConstructor("AccountId");
export const beneficiaryId = uuidConstructor("BeneficiaryId");
export const instructionId = uuidConstructor("InstructionId");
export const paymentOrderId = uuidConstructor("PaymentOrderId");
export const effectId = uuidConstructor("EffectId");
export const actorId = uuidConstructor("ActorId");
export const apiClientId = uuidConstructor("ApiClientId");
export const corridorId = uuidConstructor("CorridorId");
export const ruleId = uuidConstructor("RuleId");

export const providerId = slugConstructor("ProviderId");
/** e.g. `payout.uk_domestic`, `account.open`. Dotted segments, each a slug. */
export const operationId = (value: string): OperationId => {
  const segments = value.split(".");
  if (
    segments.length < 2 ||
    value.length > SLUG_MAX_LENGTH ||
    !segments.every((segment) => SLUG.test(segment))
  ) {
    throw new InvalidIdentifierError("OperationId", value);
  }
  return value as OperationId;
};
