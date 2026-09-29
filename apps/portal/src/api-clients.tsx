import { useCallback, useEffect, useState } from "react";
import type {
  ApiClientListWire,
  ApiClientWire,
  ScopeHistoryWire,
} from "@baas/contracts";
import { KNOWN_SCOPES } from "@baas/contracts";
import type { ApiClient } from "./api.js";

/**
 * API clients and their scopes (MP-10, findings D2, F1 and F2).
 *
 * **Finding F2 is why this screen exists at all**: the incumbent's portal
 * cannot edit scopes, so the changes are made directly in the database, where
 * there is certainly no audit row. An editor unpleasant enough to be bypassed
 * reproduces the finding, so the grant form is two fields and a button.
 *
 * **Finding F1 governs every control here**: a disabled button always says
 * why. There are three reasons one can be disabled on this screen — no scope
 * chosen, no reason given, or the operator is not an admin — and each says so
 * in its own words rather than leaving a dead control.
 *
 * **O16 answered: one person.** A grant is a button, not a request. If that
 * changes, the backend needs a pending state it does not have, so this screen
 * must not invent a "requested" status and pretend.
 */
type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly clients: readonly ApiClientWire[] }
  | { readonly kind: "failed"; readonly message: string };

export function ApiClientsScreen({
  api,
}: {
  api: ApiClient;
}): React.JSX.Element {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [open, setOpen] = useState<string | undefined>(undefined);

  const refresh = useCallback((): void => {
    void api
      .get<ApiClientListWire>("/platform/api-clients")
      .then((page) => {
        setLoad({ kind: "loaded", clients: page.clients });
      })
      .catch((cause: unknown) => {
        setLoad({
          kind: "failed",
          message: cause instanceof Error ? cause.message : "Could not load.",
        });
      });
  }, [api]);

  useEffect(refresh, [refresh]);

  if (load.kind === "loading") {
    return <p>Loading API clients…</p>;
  }
  if (load.kind === "failed") {
    return <p role="alert">{load.message}</p>;
  }

  return (
    <section aria-labelledby="api-clients">
      <h2 id="api-clients">API clients</h2>
      <p>
        Every scope change is recorded against your name, with the reason you
        give. A revoked grant is kept, not deleted.
      </p>

      {load.clients.length === 0 ? (
        <p role="status">This tenant has no API clients.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Client</th>
              <th scope="col">Name</th>
              <th scope="col">Scopes today</th>
              <th scope="col">State</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {load.clients.map((client) => (
              <tr key={client.id}>
                <td>
                  <code>{client.clientId}</code>
                </td>
                <td>{client.name}</td>
                <td>
                  {client.liveScopes.length === 0
                    ? // Stated, not blank: "no scopes" and "failed to load"
                      // look identical if neither says anything.
                      "none"
                    : client.liveScopes.join(", ")}
                </td>
                <td>{client.disabled ? "disabled" : "active"}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(open === client.id ? undefined : client.id);
                    }}
                  >
                    {open === client.id ? "Close" : "Scopes"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open !== undefined && (
        <ScopeEditor api={api} apiClientId={open} onChanged={refresh} />
      )}
    </section>
  );
}

function ScopeEditor({
  api,
  apiClientId,
  onChanged,
}: {
  api: ApiClient;
  apiClientId: string;
  onChanged: () => void;
}): React.JSX.Element {
  const [history, setHistory] = useState<ScopeHistoryWire | undefined>(
    undefined,
  );
  const [scope, setScope] = useState<string>("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const isAdmin = api.roles.includes("admin");

  const load = useCallback((): void => {
    void api
      .get<ScopeHistoryWire>(
        `/platform/api-clients/${encodeURIComponent(apiClientId)}/scopes`,
      )
      .then(setHistory)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not load.");
      });
  }, [api, apiClientId]);

  useEffect(load, [load]);

  const act = (work: Promise<unknown>): void => {
    setBusy(true);
    setError(undefined);
    void work
      .then(() => {
        setReason("");
        load();
        onChanged();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "That did not work.");
      })
      .finally(() => {
        setBusy(false);
      });
  };

  // Finding F1: three reasons a grant can be refused, each said in its own
  // words. A control that is dead and silent is the thing the finding is about.
  const blocked = !isAdmin
    ? "Only an admin can change scopes. You can read this history."
    : scope === ""
      ? "Choose a scope to grant."
      : reason.trim() === ""
        ? "Give a reason — it is stored with the grant."
        : undefined;

  return (
    <article aria-labelledby="scopes">
      <h3 id="scopes">Scopes</h3>
      {error !== undefined && <p role="alert">{error}</p>}

      <form
        onSubmit={(event: React.SyntheticEvent) => {
          event.preventDefault();
          act(
            api.post(
              `/platform/api-clients/${encodeURIComponent(apiClientId)}/scopes`,
              { scope, reason: reason.trim() },
            ),
          );
        }}
      >
        <label htmlFor="scope">Scope</label>
        <select
          id="scope"
          value={scope}
          onChange={(event) => {
            setScope(event.target.value);
          }}
          disabled={!isAdmin}
        >
          {/* A closed list, because the service refuses anything else. A free
              text field would let an operator grant `mobile:account`, see it
              listed as granted, and wonder why the caller still gets 403s. */}
          <option value="">Choose…</option>
          {KNOWN_SCOPES.map((known) => (
            <option key={known} value={known}>
              {known}
            </option>
          ))}
        </select>

        <label htmlFor="reason">Reason</label>
        <input
          id="reason"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          disabled={!isAdmin}
        />

        <button type="submit" disabled={blocked !== undefined || busy}>
          {busy ? "Working…" : "Grant"}
        </button>
        {blocked !== undefined && <span role="note"> {blocked}</span>}
      </form>

      <h4>History</h4>
      {history === undefined && error === undefined && <p>Loading history…</p>}
      {history !== undefined && history.grants.length === 0 && (
        <p role="status">This client has never held a scope.</p>
      )}
      {history !== undefined && history.grants.length > 0 && (
        <ul>
          {history.grants.map((grant) => (
            <li key={grant.id}>
              <strong>{grant.scope}</strong> —{" "}
              {grant.live ? (
                <>
                  granted {grant.grantedAt}, “{grant.reason}”
                  {isAdmin && (
                    <>
                      {" "}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          act(
                            api.remove(
                              `/platform/api-clients/${encodeURIComponent(apiClientId)}/scopes/${encodeURIComponent(grant.scope)}`,
                            ),
                          );
                        }}
                      >
                        Revoke
                      </button>
                    </>
                  )}
                </>
              ) : (
                // Kept, and shown. A revoked grant is the only evidence that
                // access once existed, which is what an audit asks about.
                <>
                  granted {grant.grantedAt}, revoked {grant.revokedAt ?? "—"}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
