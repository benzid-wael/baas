import { useEffect, useState } from "react";
import type { ApiClient } from "./api.js";

/**
 * What the console shows a signed-in operator first (MP-7a).
 *
 * Deliberately the system state rather than a customer: it proves the session
 * reaches the API without anyone having to know a customer identifier, and it
 * is the screen an incident starts on. MP-8 gives it the full treatment — the
 * four capability reasons, the closed set shown as text rather than a colour.
 * This is the honest minimum that makes signing in worth doing.
 */
export interface SystemState {
  readonly migrations: { readonly applied: readonly string[] };
  readonly schema: {
    readonly matches: boolean;
    readonly undeclared: readonly string[];
    readonly missing: readonly string[];
  };
  readonly outbox: {
    readonly unresolved: number;
    readonly depths: readonly {
      readonly state: string;
      readonly count: number;
    }[];
  };
  readonly inbox: {
    readonly unprocessed: number;
    readonly rejectedSignatures: number;
  };
}

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly state: SystemState }
  | { readonly kind: "failed"; readonly message: string };

export function SystemPanel({ api }: { api: ApiClient }): React.JSX.Element {
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    void api
      .get<SystemState>("/platform/system")
      .then((state) => {
        if (live) {
          setLoad({ kind: "loaded", state });
        }
      })
      .catch((cause: unknown) => {
        if (live) {
          setLoad({
            kind: "failed",
            message: cause instanceof Error ? cause.message : "Could not load.",
          });
        }
      });
    return () => {
      // The tab may navigate away mid-request; setting state on an unmounted
      // component is a warning today and a leak in a screen that polls.
      live = false;
    };
  }, [api]);

  if (load.kind === "loading") {
    return <p>Loading system state…</p>;
  }
  if (load.kind === "failed") {
    return <p role="alert">{load.message}</p>;
  }

  const { state } = load;
  return (
    <section aria-labelledby="system">
      <h2 id="system">System</h2>
      <dl>
        <dt>Schema</dt>
        <dd>
          {state.schema.matches
            ? "matches the declaration"
            : `drifted: ${[...state.schema.undeclared, ...state.schema.missing].join(", ")}`}
        </dd>

        <dt>Migrations applied</dt>
        <dd>{state.migrations.applied.length}</dd>

        <dt>Outbox, unresolved</dt>
        {/* Zero is shown as zero. It is a real count, and this is the one
            number on the screen where "nothing to see" is the good news. */}
        <dd>{state.outbox.unresolved}</dd>

        <dt>Inbox, unprocessed</dt>
        <dd>{state.inbox.unprocessed}</dd>

        <dt>Callbacks with a bad signature</dt>
        <dd>{state.inbox.rejectedSignatures}</dd>
      </dl>
    </section>
  );
}
