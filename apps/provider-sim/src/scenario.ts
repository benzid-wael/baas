import { Duration } from "@baas/domain";

/**
 * How a webhook behaves after the partner has accepted an operation.
 *
 * This is the reason the simulator exists. Review finding C2:
 * `keel_webhook_event` has never contained a row in development, and that
 * single absence is the root cause behind an unknown account-opening outcome,
 * permanently pending transfers, and a probably-related history-sync failure.
 *
 * A simulator that always delivers promptly would reproduce none of that. The
 * interesting behaviours are the ones that broke the incumbent, so they are
 * first-class settings rather than faults to be fixed:
 *
 *   `prompt`      the happy path
 *   `delayed`     arrives after the caller has stopped waiting
 *   `never`       accepted, then silence — the A7 case, which must resolve by
 *                 reconciliation rather than by an operator
 *   `duplicate`   delivered twice, so ingestion must be idempotent
 *   `out_of_order` settled before accepted, so Outcome transitions must be
 *                 monotonic and a late `accepted` must not overwrite `settled`
 *   `unsigned`    delivered with a bad signature, which must be rejected and
 *                 recorded rather than ignored
 */
export type DeliveryMode =
  "prompt" | "delayed" | "never" | "duplicate" | "out_of_order" | "unsigned";

export const DELIVERY_MODES: readonly DeliveryMode[] = [
  "prompt",
  "delayed",
  "never",
  "duplicate",
  "out_of_order",
  "unsigned",
];

export interface Scenario {
  readonly mode: DeliveryMode;
  /** How long `delayed` waits. Also the gap between duplicates. */
  readonly delay: Duration;
}

export const DEFAULT_SCENARIO: Scenario = {
  mode: "prompt",
  delay: Duration.ofSeconds(2),
};

export function isDeliveryMode(value: string): value is DeliveryMode {
  return (DELIVERY_MODES as readonly string[]).includes(value);
}

/**
 * The events a single accepted operation produces under a scenario, in the
 * order they should be sent. An empty list is a legitimate outcome: `never`
 * is a behaviour, not an error.
 */
export function plannedDeliveries(
  scenario: Scenario,
  states: { readonly accepted: string; readonly settled: string },
): readonly {
  readonly state: string;
  readonly afterMs: number;
  readonly corrupt: boolean;
}[] {
  const delay = scenario.delay.milliseconds;
  switch (scenario.mode) {
    case "prompt":
      return [{ state: states.settled, afterMs: 0, corrupt: false }];
    case "delayed":
      return [{ state: states.settled, afterMs: delay, corrupt: false }];
    case "never":
      return [];
    case "duplicate":
      return [
        { state: states.settled, afterMs: 0, corrupt: false },
        { state: states.settled, afterMs: delay, corrupt: false },
      ];
    case "out_of_order":
      return [
        { state: states.settled, afterMs: 0, corrupt: false },
        { state: states.accepted, afterMs: delay, corrupt: false },
      ];
    case "unsigned":
      return [{ state: states.settled, afterMs: 0, corrupt: true }];
  }
}
