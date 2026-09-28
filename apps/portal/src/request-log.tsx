import { useCallback, useEffect, useState } from "react";
import type {
  ProviderCallSummaryWire,
  ProviderCallWire,
} from "@baas/contracts";
import type { ApiClient } from "./api.js";

/**
 * The provider request log (MP-9, finding C4).
 *
 * **An operator surface, not a debug dump.** Finding C4 calls the incumbent's
 * version "the only reason several failures were explicable" and asks for it to
 * be treated as a product. The difference is the filters: an incident does not
 * start with "show me everything", it starts with *"this customer says their
 * balance is wrong"* — and the only identifier anybody has is an account
 * reference.
 *
 * **Bodies are not in the list.** They are the reason this is the most
 * sensitive table in the service, and a list view puts fifty of them on one
 * screen to answer a question the status and duration usually answer. Opening
 * one is a second act, and the service audits it separately.
 */
type Filter = "accountReference" | "correlationId" | "providerId";

const FILTERS: { readonly key: Filter; readonly label: string }[] = [
  // Account first, deliberately: it is what an incident starts from.
  { key: "accountReference", label: "Account reference" },
  { key: "correlationId", label: "Correlation id" },
  { key: "providerId", label: "Provider" },
];

interface Page {
  readonly items: readonly ProviderCallSummaryWire[];
  readonly nextCursor?: string;
}

export function RequestLog({ api }: { api: ApiClient }): React.JSX.Element {
  const [by, setBy] = useState<Filter>("accountReference");
  const [value, setValue] = useState("");
  const [items, setItems] = useState<readonly ProviderCallSummaryWire[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [searched, setSearched] = useState(false);
  const [open, setOpen] = useState<string | undefined>(undefined);

  const load = useCallback(
    (append: boolean, after?: string): void => {
      const query = new URLSearchParams();
      const trimmed = value.trim();
      if (trimmed !== "") {
        query.set(by, trimmed);
      }
      if (after !== undefined) {
        query.set("cursor", after);
      }
      setLoading(true);
      setError(undefined);
      void api
        .get<Page>(`/platform/provider-requests?${query.toString()}`)
        .then((page) => {
          setItems((existing) =>
            append ? [...existing, ...page.items] : page.items,
          );
          setCursor(page.nextCursor);
          setSearched(true);
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "Could not load.");
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [api, by, value],
  );

  return (
    <section aria-labelledby="request-log">
      <h2 id="request-log">Provider requests</h2>
      <p>
        Every call this service made to a provider. Reading one is recorded
        against your name.
      </p>

      <form
        onSubmit={(event: React.SyntheticEvent) => {
          event.preventDefault();
          setOpen(undefined);
          load(false);
        }}
      >
        <label htmlFor="filter">Filter by</label>
        <select
          id="filter"
          value={by}
          onChange={(event) => {
            setBy(event.target.value as Filter);
          }}
        >
          {FILTERS.map((filter) => (
            <option key={filter.key} value={filter.key}>
              {filter.label}
            </option>
          ))}
        </select>

        <label htmlFor="filter-value">Value</label>
        <input
          id="filter-value"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />

        <button type="submit" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
        {value.trim() === "" && (
          // Finding F1: a control whose behaviour is not obvious says what it
          // will do. Searching with no filter is allowed and is sometimes what
          // you want; it should not be a surprise.
          <span role="note"> Leave empty to see the most recent calls.</span>
        )}
      </form>

      {error !== undefined && <p role="alert">{error}</p>}

      {searched && items.length === 0 && error === undefined && (
        <p role="status">No provider calls match that.</p>
      )}

      {items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Provider</th>
              <th scope="col">Operation</th>
              <th scope="col">Account</th>
              <th scope="col">Outcome</th>
              <th scope="col">Took</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {items.map((call) => (
              <tr key={call.id}>
                <td>{call.startedAt}</td>
                <td>{call.providerId}</td>
                <td>
                  <code>{call.operation}</code>
                </td>
                <td>{call.accountReference ?? "—"}</td>
                <td>{describeOutcome(call)}</td>
                <td>{call.durationMs} ms</td>
                <td>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(open === call.id ? undefined : call.id);
                    }}
                  >
                    {open === call.id ? "Hide" : "Open"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {cursor !== undefined && (
        <button
          type="button"
          onClick={() => {
            load(true, cursor);
          }}
        >
          Load more
        </button>
      )}

      {open !== undefined && <CallDetail api={api} id={open} />}
    </section>
  );
}

/**
 * The outcome in words.
 *
 * **`unreachable` is not `rejected`**, and the difference is the whole reason
 * the outbox keeps three states: a call that never got an answer may still
 * have moved money. A screen that renders both as "failed" hides the one
 * distinction that decides whether it is safe to retry.
 */
function describeOutcome(call: ProviderCallSummaryWire): string {
  if (call.outcome === "ok") {
    return `ok (${String(call.responseStatus ?? "—")})`;
  }
  if (call.outcome === "rejected") {
    return `refused (${String(call.responseStatus ?? "—")})`;
  }
  return "no answer — we do not know whether it acted";
}

/**
 * One call, bodies included.
 *
 * Fetched only when asked for. The service audits this separately from the
 * list, and loading it eagerly would record an intention nobody had.
 */
function CallDetail({
  api,
  id,
}: {
  api: ApiClient;
  id: string;
}): React.JSX.Element {
  const [call, setCall] = useState<ProviderCallWire | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setCall(undefined);
    void api
      .get<ProviderCallWire>(`/platform/provider-requests/${id}`)
      .then((found) => {
        if (live) {
          setCall(found);
        }
      })
      .catch((cause: unknown) => {
        if (live) {
          setError(cause instanceof Error ? cause.message : "Could not load.");
        }
      });
    return () => {
      live = false;
    };
  }, [api, id]);

  if (error !== undefined) {
    return <p role="alert">{error}</p>;
  }
  if (call === undefined) {
    return <p>Loading the call…</p>;
  }

  return (
    <article aria-labelledby="call-detail">
      <h3 id="call-detail">
        {call.providerId} · <code>{call.operation}</code>
      </h3>
      <p>
        {/* Said once, where someone about to screenshot this will see it. */}
        <small>
          Bodies are scrubbed of the shapes we recognise — email addresses,
          IBANs, card numbers, phone numbers — and truncated past 16KB. That is
          a reduction of risk, not an elimination of it: treat what follows as
          customer data.
        </small>
      </p>
      {call.errorMessage !== null && (
        <p role="alert">
          <strong>Error:</strong> {call.errorMessage}
        </p>
      )}
      <h4>Request</h4>
      <pre>{call.requestBody === "" ? "(no body)" : call.requestBody}</pre>
      <h4>Response</h4>
      <pre>{call.responseBody === "" ? "(no body)" : call.responseBody}</pre>
    </article>
  );
}
