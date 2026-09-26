import { uuidv7 } from "uuidv7";
import type { IdGenerator, Uuid } from "@baas/domain";

/**
 * UUIDv7: a 48-bit big-endian timestamp followed by randomness, so ids sort by
 * creation and index locality is good. It also means an `EffectId` — which is
 * the provider idempotency key — carries its own creation time, which is worth
 * having when reconciling an effect whose row is the only evidence left.
 */
export class UuidV7Generator implements IdGenerator {
  next(): Uuid {
    return uuidv7() as Uuid;
  }
}

/**
 * A generator that yields a known sequence, so a test asserts an identifier
 * rather than matching its shape. Exhausting the sequence throws rather than
 * falling back to randomness — a test that generates more ids than it declared
 * has changed behaviour and should say so.
 */
export class SequenceIdGenerator implements IdGenerator {
  private index = 0;

  constructor(private readonly sequence: readonly string[]) {
    if (sequence.length === 0) {
      throw new Error("SequenceIdGenerator requires at least one identifier");
    }
  }

  next(): Uuid {
    const value = this.sequence[this.index];
    if (value === undefined) {
      throw new Error(
        `SequenceIdGenerator exhausted after ${this.index.toString()} identifiers`,
      );
    }
    this.index += 1;
    return value as Uuid;
  }
}
