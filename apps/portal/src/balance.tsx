import type { BalanceWire } from "@baas/contracts";

/**
 * Rendering a balance, in all three of its shapes (MP-7b, finding F4).
 *
 * This is the smallest component in the portal and the one most worth getting
 * right. The incumbent's portal rendered an empty charges array as blank next
 * to a confident total, which read as fee-free. A balance carries the same
 * hazard in a sharper form: **an absent balance shown as `0.00` reads as "you
 * have no money", which is a worse lie than an error.**
 *
 * So the contract has three shapes and this renders three visibly different
 * things:
 *
 *   observed + fresh   the figure
 *   observed + stale   the figure, and how old it is
 *   unavailable        no figure at all, and why
 *
 * There is deliberately no default branch that falls back to a number.
 */
export function Balance({
  balance,
}: {
  balance: BalanceWire;
}): React.JSX.Element {
  if (balance.kind === "unavailable") {
    return (
      <span className="balance balance-unavailable">
        <strong>Not available</strong>{" "}
        <span className="balance-reason">{reasonOf(balance.reason)}</span>
      </span>
    );
  }

  return (
    <span
      className={`balance ${balance.fresh ? "balance-fresh" : "balance-stale"}`}
    >
      <strong>
        {balance.available.amount} {balance.available.currency}
      </strong>
      {!balance.fresh && (
        // The age is shown, never hidden. A figure that might be an hour old
        // presented as current is the same lie as a zero, more quietly told.
        <span className="balance-age"> as of {ageOf(balance.ageSeconds)}</span>
      )}
    </span>
  );
}

/**
 * Why there is no figure, in words rather than a code.
 *
 * The two reasons mean different things to the person reading: one is "we have
 * never had this", the other is "we could not get it just now". Collapsing
 * them into "unavailable" would throw away the distinction the service goes to
 * some trouble to make (correction C15).
 */
function reasonOf(reason: "never_observed" | "provider_unreachable"): string {
  return reason === "never_observed"
    ? "we have not seen a balance for this account yet"
    : "we could not reach the bank just now";
}

/**
 * How old, in words a person reads rather than a duration they parse.
 *
 * Rounded down and deliberately coarse. "as of 11 minutes ago" is the claim;
 * "as of 11 minutes and 4 seconds ago" is precision the number does not have,
 * since the observation was already old when it was stored.
 */
export function ageOf(seconds: number): string {
  if (seconds < 60) {
    return "moments ago";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes.toString()} ${plural(minutes, "minute")} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours.toString()} ${plural(hours, "hour")} ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days.toString()} ${plural(days, "day")} ago`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
