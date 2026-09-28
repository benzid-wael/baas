import { useCallback, useEffect, useState } from "react";
import type {
  AccountWire,
  CustomerSummaryWire,
  TransactionWire,
} from "@baas/contracts";
import type { ApiClient } from "./api.js";
import { Balance } from "./balance.js";

/**
 * Looking a customer up, and reading what they have (MP-7b).
 *
 * **Exact match only, one identifier at a time.** There is no listing and no
 * prefix search, because the API has neither: a console that pages through
 * every customer, or probes an identifier a character at a time, is an
 * extraction tool. The form makes that visible rather than leaving it as a
 * property of an endpoint nobody reads.
 *
 * Every read here writes an audit row naming the operator and the subject. The
 * screen says so, once, where it cannot be missed.
 */
type Search =
  | { readonly kind: "idle" }
  | { readonly kind: "searching" }
  | { readonly kind: "found"; readonly customer: CustomerSummaryWire }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly message: string };

type By = "externalUserUuid" | "accountReference";

export function CustomerScreen({ api }: { api: ApiClient }): React.JSX.Element {
  const [by, setBy] = useState<By>("externalUserUuid");
  const [value, setValue] = useState("");
  const [search, setSearch] = useState<Search>({ kind: "idle" });

  // `React.SyntheticEvent`, not `FormEvent`: React 19's types deprecate the
  // latter on the grounds that it does not correspond to a real DOM event.
  const submit = (event: React.SyntheticEvent): void => {
    event.preventDefault();
    const trimmed = value.trim();
    /* c8 ignore next 3 -- the button is disabled; belt and braces */
    if (trimmed === "") {
      return;
    }
    setSearch({ kind: "searching" });
    void api
      .get<CustomerSummaryWire>(
        `/platform/customers?${by}=${encodeURIComponent(trimmed)}`,
      )
      .then((customer) => {
        setSearch({ kind: "found", customer });
      })
      .catch((cause: unknown) => {
        const message =
          cause instanceof Error ? cause.message : "Search failed.";
        setSearch(
          message.startsWith("Not found")
            ? { kind: "missing" }
            : { kind: "failed", message },
        );
      });
  };

  const empty = value.trim() === "";

  return (
    <section aria-labelledby="customer">
      <h2 id="customer">Find a customer</h2>
      <p>
        Exact match only — there is no browsing. Every lookup is recorded
        against your name, whether or not it finds anything.
      </p>

      <form onSubmit={submit}>
        <label htmlFor="by">Search by</label>
        <select
          id="by"
          value={by}
          onChange={(event) => {
            setBy(event.target.value as By);
          }}
        >
          <option value="externalUserUuid">Customer id</option>
          <option value="accountReference">Account reference</option>
        </select>

        <label htmlFor="value">Value</label>
        <input
          id="value"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />

        <button type="submit" disabled={empty || search.kind === "searching"}>
          {search.kind === "searching" ? "Searching…" : "Search"}
        </button>
        {/* Finding F1: a disabled control always says why it is disabled. */}
        {empty && <span role="note"> Enter a value to search.</span>}
      </form>

      {search.kind === "missing" && (
        // Plainly "no such customer". The mobile surface's deliberate
        // ambiguity between "not yours" and "does not exist" is not copied
        // here: reading any customer is this role's job, so there is no
        // existence to protect.
        <p role="status">No customer matches that.</p>
      )}
      {search.kind === "failed" && <p role="alert">{search.message}</p>}
      {search.kind === "found" && (
        <CustomerDetail api={api} customer={search.customer} />
      )}
    </section>
  );
}

function CustomerDetail({
  api,
  customer,
}: {
  api: ApiClient;
  customer: CustomerSummaryWire;
}): React.JSX.Element {
  const [accounts, setAccounts] = useState<readonly AccountWire[] | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setAccounts(undefined);
    setOpen(undefined);
    void api
      .get<{ accounts: AccountWire[] }>(
        `/platform/customers/${encodeURIComponent(customer.customerId)}/accounts`,
      )
      .then((page) => {
        if (live) {
          setAccounts(page.accounts);
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
  }, [api, customer.customerId]);

  return (
    <article aria-labelledby="accounts">
      <h3 id="accounts">Accounts</h3>
      <p>
        Customer <code>{customer.externalUserUuid}</code>
      </p>

      {error !== undefined && <p role="alert">{error}</p>}
      {accounts === undefined && error === undefined && (
        <p>Loading accounts…</p>
      )}

      {accounts !== undefined && accounts.length === 0 && (
        // Not a blank space. An empty list and a list that failed to load look
        // identical if neither says anything, which is finding F4's cousin.
        <p role="status">This customer has no accounts.</p>
      )}

      {accounts !== undefined && accounts.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Product</th>
              <th scope="col">Status</th>
              <th scope="col">Balance</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.accountReference}>
                <td>
                  <code>{account.accountReference}</code>
                </td>
                <td>{account.product}</td>
                <td>{account.status}</td>
                <td>
                  <Balance balance={account.balance} />
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(
                        open === account.accountReference
                          ? undefined
                          : account.accountReference,
                      );
                    }}
                  >
                    {open === account.accountReference
                      ? "Hide transactions"
                      : "Transactions"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open !== undefined && <Transactions api={api} accountReference={open} />}
    </article>
  );
}

function Transactions({
  api,
  accountReference,
}: {
  api: ApiClient;
  accountReference: string;
}): React.JSX.Element {
  const [items, setItems] = useState<readonly TransactionWire[] | undefined>(
    undefined,
  );
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(
    (after?: string): void => {
      const query =
        after === undefined ? "" : `?cursor=${encodeURIComponent(after)}`;
      void api
        .get<{ items: TransactionWire[]; nextCursor?: string }>(
          `/platform/accounts/${encodeURIComponent(accountReference)}/transactions${query}`,
        )
        .then((page) => {
          setItems((existing) => [...(existing ?? []), ...page.items]);
          setCursor(page.nextCursor);
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "Could not load.");
        });
    },
    [api, accountReference],
  );

  useEffect(() => {
    setItems(undefined);
    setCursor(undefined);
    load();
  }, [load]);

  return (
    <section aria-labelledby="transactions">
      <h4 id="transactions">Transactions for {accountReference}</h4>
      {error !== undefined && <p role="alert">{error}</p>}
      {items === undefined && error === undefined && (
        <p>Loading transactions…</p>
      )}
      {items !== undefined && items.length === 0 && (
        <p role="status">No transactions for this account.</p>
      )}
      {items !== undefined && items.length > 0 && (
        <ul>
          {items.map((transaction) => (
            <li key={transaction.transactionReference}>
              <time dateTime={transaction.occurredAt}>
                {transaction.occurredAt}
              </time>{" "}
              {transaction.direction === "debit" ? "−" : "+"}
              {transaction.amount.amount} {transaction.amount.currency} ·{" "}
              {transaction.status}
              {transaction.counterpartyName !== null && (
                <> · {transaction.counterpartyName}</>
              )}
            </li>
          ))}
        </ul>
      )}
      {cursor !== undefined && (
        <button
          type="button"
          onClick={() => {
            load(cursor);
          }}
        >
          Load more
        </button>
      )}
    </section>
  );
}
