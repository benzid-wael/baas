import { useEffect, useState } from "react";
import type { SystemStateWire } from "@baas/contracts";
import type { ApiClient } from "./api.js";
import { ageOf } from "./balance.js";

/**
 * System health (MP-5, MP-8).
 *
 * **Show the reason, not the red dot.** Finding A1 is a capability that
 * vanished from routing and cost hours in the policy layer for a defect in an
 * adapter. The service answers with a closed set of four reasons precisely so
 * that this screen can say which of four different people should be looking at
 * it; rendering them all as "unavailable" would throw that away and put the
 * hours back.
 */
type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly state: SystemStateWire }
  | { readonly kind: "failed"; readonly message: string };

export function SystemPanel({ api }: { api: ApiClient }): React.JSX.Element {
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    void api
      .get<SystemStateWire>("/platform/system")
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
      <Providers capabilities={state.capabilities} />
      <Queues outbox={state.outbox} inbox={state.inbox} />
      <Schema migrations={state.migrations} schema={state.schema} />
    </section>
  );
}

function Providers({
  capabilities,
}: {
  capabilities: SystemStateWire["capabilities"];
}): React.JSX.Element {
  return (
    <article aria-labelledby="providers">
      <h3 id="providers">Providers</h3>
      {capabilities.providers.length === 0 ? (
        // Said, not left blank. "No providers configured" and "the list failed
        // to load" look identical if neither says anything.
        <p role="status">No provider is configured in this environment.</p>
      ) : (
        <ul>
          {capabilities.providers.map((provider) => (
            <li key={provider.provider}>
              <strong>{provider.provider}</strong>{" "}
              {provider.available ? (
                <>
                  available —{" "}
                  {provider.operations.length === 0
                    ? "no operations"
                    : provider.operations.join(", ")}
                </>
              ) : (
                <span role="note">{explain(provider.reason)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p>
        <small>Checked {capabilities.checkedAt}</small>
      </p>
    </article>
  );
}

/**
 * The four reasons, in words, and each names who should be looking at it.
 *
 * The distinction is the reason the set is closed: `not_configured` is a job
 * for whoever holds the credentials, `adapter_absent` for whoever ships the
 * code, and `disabled_by_configuration` is nobody's job at all.
 */
function explain(reason: string | undefined): string {
  switch (reason) {
    case "not_configured":
      return "not configured — a setting is missing. Whoever holds the credentials.";
    case "adapter_absent":
      return "this build cannot talk to that provider. Whoever ships the code.";
    case "disabled_by_configuration":
      return "turned off deliberately.";
    case "operation_not_implemented":
      return "configured, but this build implements none of its operations.";
    default:
      // A reason the service added and this screen has not learned yet. Shown
      // raw rather than swallowed: an unexplained code is worse than a
      // sentence, and far better than silence.
      return `unavailable (${reason ?? "no reason given"}).`;
  }
}

function Queues({
  outbox,
  inbox,
}: {
  outbox: SystemStateWire["outbox"];
  inbox: SystemStateWire["inbox"];
}): React.JSX.Element {
  return (
    <article aria-labelledby="queues">
      <h3 id="queues">Queues</h3>
      <dl>
        {/* The most important number on the screen: pending, dispatched and
            unknown together. A growing `unknown` means we do not know whether
            the provider acted, which is the one state retrying cannot fix. */}
        <dt>Effects awaiting an outcome</dt>
        <dd>
          <strong>{outbox.unresolved}</strong>
          {outbox.unresolved > 0 && <> — see the breakdown below</>}
        </dd>

        <dt>Inbox, unprocessed</dt>
        <dd>
          {inbox.unprocessed}
          {inbox.oldestUnprocessedAgeSeconds !== undefined && (
            <> · oldest {ageOf(inbox.oldestUnprocessedAgeSeconds)}</>
          )}
        </dd>

        <dt>Callbacks that failed their signature</dt>
        <dd>
          {inbox.rejectedSignatures}
          {inbox.rejectedSignatures > 0 && (
            // Not an error banner: one is unremarkable, a rising count is a
            // rotated credential or someone probing. The screen says which
            // question to ask rather than answering it.
            <span role="note">
              {" "}
              — a rotated partner credential, or someone probing
            </span>
          )}
        </dd>
      </dl>

      {outbox.depths.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">State</th>
              <th scope="col">Count</th>
              <th scope="col">Oldest</th>
            </tr>
          </thead>
          <tbody>
            {outbox.depths.map((depth) => (
              <tr key={depth.state}>
                <td>{depth.state}</td>
                <td>{depth.count}</td>
                <td>
                  {depth.oldestAgeSeconds === undefined
                    ? "—"
                    : ageOf(depth.oldestAgeSeconds)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}

function Schema({
  migrations,
  schema,
}: {
  migrations: SystemStateWire["migrations"];
  schema: SystemStateWire["schema"];
}): React.JSX.Element {
  return (
    <article aria-labelledby="schema">
      <h3 id="schema">Schema</h3>
      {schema.matches ? (
        <p>The database matches what this build declares.</p>
      ) : (
        // Names the columns. Finding C1 is a readiness probe that trusts the
        // migration ledger; the useful answer at three in the morning is which
        // column disagrees, not that something does.
        <p role="alert">
          <strong>Drift.</strong>{" "}
          {schema.undeclared.length > 0 && (
            <>
              In the database but not declared: {schema.undeclared.join(", ")}
              .{" "}
            </>
          )}
          {schema.missing.length > 0 && (
            <>Declared but not in the database: {schema.missing.join(", ")}.</>
          )}
        </p>
      )}
      <p>
        {migrations.applied.length} migrations applied
        {migrations.lastAppliedAt !== undefined && (
          <>, most recently {migrations.lastAppliedAt}</>
        )}
        .
      </p>
    </article>
  );
}
