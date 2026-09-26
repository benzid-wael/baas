import { Duration } from "@baas/domain";
import type { Clock, IdGenerator, Instant } from "@baas/domain";
import { formatInstant } from "@baas/platform";
import { signKeel, signRuya } from "./signing.js";
import { plannedDeliveries } from "./scenario.js";
import type { Scenario } from "./scenario.js";

export type ProviderKind = "keel" | "ruya";

export interface DeliveryTarget {
  readonly url: string;
  readonly provider: ProviderKind;
}

export interface WebhookEnvelope {
  readonly eventId: string;
  readonly eventType: string;
  readonly reference: string;
  readonly state: string;
  readonly occurredAt: string;
}

export interface ScheduledDelivery {
  readonly dueAt: Instant;
  /** Milliseconds after acceptance. Carried so a caller never re-derives it. */
  readonly afterMs: number;
  readonly envelope: WebhookEnvelope;
  readonly corrupt: boolean;
}

export interface SignedRequest {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface Credentials {
  /** Keel signs with RSA; the PEM is the simulator's own throwaway key. */
  readonly keelPrivateKeyPem: string;
  /** Ruya signs with HMAC. */
  readonly ruyaSecret: string;
}

/**
 * Plans and signs webhook deliveries. Deliberately does no I/O and holds no
 * timer: it produces a list of what to send and when, and the caller decides
 * how to wait. That makes every scenario testable without a clock that moves.
 */
export class DeliveryPlanner {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly credentials: Credentials,
  ) {}

  plan(
    scenario: Scenario,
    reference: string,
    eventType: string,
    states: { readonly accepted: string; readonly settled: string },
  ): readonly ScheduledDelivery[] {
    const now = this.clock.now();
    return plannedDeliveries(scenario, states).map((step) => {
      const dueAt = now.plus(Duration.ofMilliseconds(step.afterMs));
      return {
        dueAt,
        afterMs: step.afterMs,
        corrupt: step.corrupt,
        envelope: {
          eventId: this.ids.next(),
          eventType,
          reference,
          state: step.state,
          occurredAt: formatInstant(dueAt),
        },
      };
    });
  }

  sign(target: DeliveryTarget, delivery: ScheduledDelivery): SignedRequest {
    const body = JSON.stringify(delivery.envelope);
    const signature =
      target.provider === "keel"
        ? signKeel(body, this.credentials.keelPrivateKeyPem)
        : signRuya(body, this.credentials.ruyaSecret);

    const header =
      target.provider === "keel"
        ? "x-digital-signature"
        : "x-ruya-callback-signature";

    return {
      url: target.url,
      body,
      headers: {
        "content-type": "application/json",
        // A corrupt signature is a scenario, not a bug: the receiver must
        // reject it and record the rejection, not ignore the delivery.
        [header]: delivery.corrupt
          ? `${signature.slice(0, -4)}XXXX`
          : signature,
        "x-sim-event-id": delivery.envelope.eventId,
      },
    };
  }
}
