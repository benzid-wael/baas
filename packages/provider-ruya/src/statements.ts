import { CalendarDate } from "@baas/domain";
import type { ProviderStatement, StatementReadPort } from "@baas/domain";
import type { RuyaHttp } from "./http.js";

const STATEMENT_INQUIRY = "/accountStatementServices/statementInquiry";

const SELECT = [
  "gits_cif",
  "_gits_financialaccountnumber_value",
  "gits_from",
  "gits_to",
  "gits_securefilepath",
  "gits_filename",
].join(",");

interface RawStatementRow {
  gits_from?: string;
  gits_to?: string;
  gits_filename?: string;
  gits_securefilepath?: string;
}

interface RawStatementList {
  value?: RawStatementRow[];
}

/**
 * The only values interpolated into the `$filter` are identifiers — a customer
 * reference and an account reference — so they are **allow-listed**, not
 * escaped.
 *
 * Doubling quotes is OData's own escape and would in fact neutralise an
 * injection, which the first version of this function relied on. It was
 * replaced because escaping accepts input that should never have reached here
 * in the first place: an identifier containing a quote, a space or a bracket
 * is not an identifier, and quietly rewriting it into a valid literal means
 * querying for a subtly different customer and showing the result as fact.
 * Refusing is louder and loses nothing real.
 */
const IDENTIFIER = /^[A-Za-z0-9._-]{1,64}$/;

export function odataIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new UnsafeODataValueError(value);
  }
  return value;
}

export class UnsafeODataValueError extends Error {
  readonly code = "provider.ruya.unsafe_odata_value";
  constructor(readonly value: string) {
    // This error is ours, not a client's, so it names the mechanism: a
    // developer reading it should know immediately where to look.
    super(
      `Refusing to build an OData filter from a value that is not an identifier: ${JSON.stringify(value)}`,
    );
    this.name = "UnsafeODataValueError";
  }
}

/**
 * Statement periods (M1-9).
 *
 * Ruya exposes statements through a Dataverse-style OData endpoint which,
 * unlike every other Ruya call, **takes none of the standard BaNCS headers** —
 * sending them produces an error that mentions none of them. That asymmetry is
 * carried over from the incumbent rather than rediscovered.
 *
 * A period is a `CalendarDate` range. A statement covering March is March in
 * the customer's calendar, and computing its boundaries in UTC moves a
 * late-evening Dubai transaction into the previous month.
 */
export class RuyaStatements implements StatementReadPort {
  constructor(private readonly http: RuyaHttp) {}

  async listStatements(request: {
    ownerReference: string;
    accountReference: string;
  }): Promise<readonly ProviderStatement[]> {
    const filter =
      `gits_cif eq '${odataIdentifier(request.ownerReference)}'` +
      ` and gits_accountreference eq '${odataIdentifier(request.accountReference)}'`;

    const raw = await this.http.get<RawStatementList>(STATEMENT_INQUIRY, {
      query: { $select: SELECT, $filter: filter },
      skipStandardHeaders: true,
    });

    return (raw.value ?? []).flatMap((row) => {
      const from = optionalDate(row.gits_from);
      const to = optionalDate(row.gits_to);
      // A row without a period is not a statement. Dropping it is better than
      // inventing a range, which would be shown to a customer as fact.
      if (from === undefined || to === undefined) {
        return [];
      }
      return [
        {
          statementReference:
            row.gits_filename ?? `${from.toString()}_${to.toString()}`,
          accountReference: request.accountReference,
          from,
          to,
          available:
            row.gits_securefilepath !== undefined &&
            row.gits_securefilepath !== "",
        },
      ];
    });
  }
}

function optionalDate(value: string | undefined): CalendarDate | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  try {
    // BaNCS sends either a bare date or a timestamp; only the date part is
    // meaningful, and the time part is whatever its exporter felt like.
    return CalendarDate.parse(value.slice(0, 10));
  } catch {
    return undefined;
  }
}
