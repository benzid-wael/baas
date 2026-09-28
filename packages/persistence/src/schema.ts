/**
 * The database, as TypeScript sees it.
 *
 * **Nothing here is hand-written any more** (New-15). Every table interface,
 * every column, every union and `DECLARED_SCHEMA` come from
 * `schema.generated.ts`, which `pnpm db:types` produces from a freshly
 * migrated database. Adding a column is a migration and a regeneration; it
 * used to be three edits, one of which was easy to forget.
 *
 * What is left is the names. The generator names a union after its table and
 * column — `EffectOutboxState`, `TransactionProjectionDirection` — which is
 * unambiguous and, for the ones this codebase talks about constantly, wordier
 * than the domain deserves. These aliases give them the names the rest of the
 * service already uses.
 *
 * They cannot go stale: an alias to a union the generator stopped producing is
 * a compile error, and an alias whose *values* drifted is impossible, because
 * there is only one declaration of the values.
 */
export * from "./schema.generated.js";

export type { EffectOutboxState as OutboxState } from "./schema.generated.js";
export type { ProviderCustomerLinkStatus as ProviderLinkStatus } from "./schema.generated.js";
export type { TransactionProjectionDirection as TransactionDirection } from "./schema.generated.js";
export type { TransactionProjectionStatus as TransactionStatus } from "./schema.generated.js";
