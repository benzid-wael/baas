import { fromMoney } from "@baas/contracts";
import type { BalanceWire } from "@baas/contracts";
import type { BalanceView } from "@baas/domain";
import { formatInstant } from "@baas/platform";

/**
 * Shared wire mapping.
 *
 * Extracted because the mobile and operator surfaces are deliberately
 * different controllers but describe a balance identically — and two copies of
 * this would be two places to forget that an absent balance is not a zero.
 */
export function toBalanceWire(balance: BalanceView): BalanceWire {
  if (balance.kind === "unavailable") {
    return { kind: "unavailable", reason: balance.reason };
  }
  return {
    kind: "observed",
    available: fromMoney(balance.available),
    current: fromMoney(balance.current),
    observedAt: formatInstant(balance.observedAt),
    // Floored and never negative: a clock that has moved backwards must not
    // surface as a balance from the future.
    ageSeconds: Math.max(0, Math.floor(balance.age.milliseconds / 1000)),
    fresh: balance.fresh,
  };
}
