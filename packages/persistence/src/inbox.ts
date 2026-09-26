import type { Kysely } from "kysely";
import type { Clock, IdGenerator } from "@baas/domain";
import { toJsDate } from "@baas/platform";
import type { Database } from "./schema.js";

/**
 * The inbox (RFC-BaaS §5.6, finding C2).
 *
 * A webhook is **recorded, not processed**, at ingress. The endpoint verifies
 * the signature, writes the body verbatim, and returns. Nothing downstream can
 * lose the delivery, because nothing downstream has run yet.
 *
 * A rejected signature is recorded too, with `signature_verified = false`.
 * Dropping it would erase the only evidence that someone is probing the
 * endpoint, and would make a misconfigured partner indistinguishable from a
 * silent one.
 */
export interface InboundEvent {
  readonly tenantId: string;
  readonly providerId: string;
  readonly externalEventId: string | null;
  readonly eventType: string | null;
  readonly providerRef: string | null;
  readonly signatureVerified: boolean;
  readonly payload: unknown;
}

export interface RecordedEvent {
  readonly id: string;
  /** False when the provider had already delivered this event id. */
  readonly isNew: boolean;
}

export class Inbox {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Record a delivery. A provider that supplies an event id gets exactly-once
   * ingestion from the unique index; one that does not is deduplicated later,
   * by the reconciler, from the outcome itself.
   */
  async record(event: InboundEvent): Promise<RecordedEvent> {
    const id = this.ids.next();
    const inserted = await this.db
      .insertInto("provider_inbox")
      .values({
        id,
        tenant_id: event.tenantId,
        provider_id: event.providerId,
        external_event_id: event.externalEventId,
        event_type: event.eventType,
        provider_ref: event.providerRef,
        signature_verified: event.signatureVerified,
        payload: JSON.stringify(event.payload),
        received_at: toJsDate(this.clock.now()),
        processed_at: null,
        process_error: null,
      })
      .onConflict((conflict) => conflict.doNothing())
      .executeTakeFirst();

    if ((inserted.numInsertedOrUpdatedRows ?? 0n) > 0n) {
      return { id, isNew: true };
    }

    const existing = await this.db
      .selectFrom("provider_inbox")
      .select("id")
      .where("provider_id", "=", event.providerId)
      .where("external_event_id", "=", event.externalEventId)
      .executeTakeFirstOrThrow();
    return { id: existing.id, isNew: false };
  }

  /** Unprocessed deliveries, oldest first. Only ones whose signature held. */
  async pending(limit: number): Promise<readonly Database["provider_inbox"][]> {
    return this.db
      .selectFrom("provider_inbox")
      .selectAll()
      .where("processed_at", "is", null)
      .where("signature_verified", "=", true)
      .orderBy("received_at")
      .limit(limit)
      .execute();
  }

  async markProcessed(id: string, error?: string): Promise<void> {
    await this.db
      .updateTable("provider_inbox")
      .set({
        processed_at: toJsDate(this.clock.now()),
        process_error: error ?? null,
      })
      .where("id", "=", id)
      .execute();
  }
}
