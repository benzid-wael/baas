import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
} from "@nestjs/common";
import { fromMoney } from "@baas/contracts";
import type {
  AccountWire,
  CustomerSummaryWire,
  ProviderCallPageWire,
  ProviderCallSummaryWire,
  ProviderCallWire,
  SystemStateWire,
  TransactionWire,
} from "@baas/contracts";
import type {
  OperatorAccountView,
  OperatorReads,
  SystemReads,
  SystemState,
} from "@baas/application";
import type { ProjectedTransaction, RecordedCall } from "@baas/persistence";
import { formatInstant, fromJsDate } from "@baas/platform";
import { OperatorSurface, Roles } from "./decorators.js";
import { toBalanceWire } from "./wire.js";
import { principalOf } from "./principal.js";
import type { RequestWithPrincipal } from "./principal.js";

export const OPERATOR_READS = "baas:OperatorReads";
export const SYSTEM_READS = "baas:SystemReads";

const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

/**
 * The operator read surface (MP-4).
 *
 * Deliberately a different controller from the mobile one, not the same
 * handlers behind a different guard: an operator reads any customer in the
 * tenant, and sharing a handler is how that authority leaks the first time
 * someone adds a parameter.
 */
@Controller("platform")
export class PlatformReadController {
  constructor(
    @Inject(OPERATOR_READS) private readonly reads: OperatorReads,
    @Inject(SYSTEM_READS) private readonly system: SystemReads,
  ) {}

  /**
   * Everything an operator currently opens a `psql` prompt for (MP-5).
   *
   * Which migrations applied, whether the declared schema matches the migrated
   * one, how deep the outbox is and how old its oldest unresolved effect is,
   * and how many inbox deliveries are unprocessed or failed their signature.
   *
   * **Not audited**, unlike every other route on this controller. It carries
   * counts, states and migration ids — no customer, no account, no personal
   * data — and a dashboard polls. Auditing it would write a row every few
   * seconds and bury the trail that exists to be read. The rule is "reading a
   * customer is audited", not "reading anything is audited": the first is a
   * control, the second is noise that hides one.
   */
  @Get("system")
  @OperatorSurface()
  @Roles("operator", "admin")
  async systemState(
    @Req() request: RequestWithPrincipal,
  ): Promise<SystemStateWire> {
    const { tenantId } = operator(request);
    return toSystemStateWire(await this.system.state(tenantId));
  }

  /**
   * Find a customer by **one** exact identifier.
   *
   * No listing and no prefix search. A console that pages through every
   * customer, or probes an identifier a character at a time, is an extraction
   * tool. Browsing may be worth adding; it should be a decision rather than a
   * side effect of a convenient query.
   */
  @Get("customers")
  @OperatorSurface()
  @Roles("operator", "admin")
  async findCustomer(
    @Req() request: RequestWithPrincipal,
    @Query("externalUserUuid") externalUserUuid?: string,
    @Query("accountReference") accountReference?: string,
    // The published type, not `unknown`. The first version returned `unknown`
    // and the portal invented its own shape to match it — and got a field name
    // wrong that type-checked on both sides (correction C16).
  ): Promise<CustomerSummaryWire> {
    const { tenantId, actor } = operator(request);

    if ((externalUserUuid === undefined) === (accountReference === undefined)) {
      throw new BadRequestException(
        "supply exactly one of externalUserUuid or accountReference",
      );
    }

    const found =
      externalUserUuid === undefined
        ? await this.reads.findCustomerByAccountReference(
            tenantId,
            actor,
            accountReference ?? "",
          )
        : await this.reads.findCustomerByExternalUuid(
            tenantId,
            actor,
            externalUserUuid,
          );

    if (found === undefined) {
      throw new NotFoundException("no such customer");
    }
    return {
      customerId: found.customerId,
      externalUserUuid: found.externalUserUuid,
      providers: found.links.map((link) => ({
        providerId: link.providerId,
        status: link.status,
        statusReason: link.statusReason,
        observedAt: formatInstant(fromJsDate(link.observedAt)),
      })),
    };
  }

  @Get("customers/:customerId/accounts")
  @OperatorSurface()
  @Roles("operator", "admin")
  async accounts(
    @Req() request: RequestWithPrincipal,
    @Param("customerId") customerId: string,
  ): Promise<{ accounts: AccountWire[] }> {
    const { tenantId, actor } = operator(request);
    const views = await this.reads.accountsOf(tenantId, actor, customerId);
    return { accounts: views.map(toAccountWire) };
  }

  @Get("accounts/:accountReference/transactions")
  @OperatorSurface()
  @Roles("operator", "admin")
  async transactions(
    @Req() request: RequestWithPrincipal,
    @Param("accountReference") accountReference: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ): Promise<{ items: TransactionWire[]; nextCursor?: string }> {
    const { tenantId, actor } = operator(request);
    const page = await this.reads.transactionsOf(
      tenantId,
      actor,
      accountReference,
      {
        limit: pageSize(limit),
        ...(cursor === undefined ? {} : { cursor }),
      },
    );
    if (page === undefined) {
      // Plainly "no such account", not the mobile surface's deliberate
      // ambiguity: reading another customer's data is this role's job, so
      // there is no existence to protect.
      throw new NotFoundException("no such account");
    }
    return {
      items: page.transactions.map((transaction) =>
        toTransactionWire(transaction, accountReference),
      ),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  /**
   * The provider request log (MP-2, finding C4).
   *
   * Finding C4 calls the incumbent's version "the only reason several failures
   * were explicable" and asks for it to be a product surface rather than an
   * implementation detail. This is that surface.
   *
   * The list deliberately **omits the bodies**. They are the reason this table
   * is the most sensitive in the service, and a list view puts fifty of them
   * on one screen for a question that is usually answered by the status and
   * the duration. Fetching one by id is a second, separately audited act.
   */
  @Get("provider-requests")
  @OperatorSurface()
  @Roles("operator", "admin")
  async providerRequests(
    @Req() request: RequestWithPrincipal,
    @Query("providerId") providerId?: string,
    @Query("correlationId") correlationId?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ): Promise<ProviderCallPageWire> {
    const { tenantId, actor } = operator(request);
    const page = await this.reads.providerCalls(tenantId, actor, {
      limit: pageSize(limit),
      providerId,
      correlationId,
      cursor,
    });
    return {
      items: page.calls.map(toCallSummaryWire),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  /** One call, bodies included. A separate act, separately audited. */
  @Get("provider-requests/:id")
  @OperatorSurface()
  @Roles("operator", "admin")
  async providerRequest(
    @Req() request: RequestWithPrincipal,
    @Param("id") id: string,
  ): Promise<ProviderCallWire> {
    const { tenantId, actor } = operator(request);
    const call = await this.reads.providerCall(tenantId, actor, id);
    if (call === undefined) {
      throw new NotFoundException("no such provider request");
    }
    return {
      ...toCallSummaryWire(call),
      requestBody: call.requestBody,
      responseBody: call.responseBody,
      errorMessage: call.errorMessage,
    };
  }
}

/**
 * The application layer returns readonly arrays; the wire type is plain JSON.
 *
 * Copied explicitly rather than cast. A cast here would hand a caller a
 * reference to the application's own array, which is how a "read" model ends
 * up mutated by a serialiser somewhere downstream.
 */
function toSystemStateWire(state: SystemState): SystemStateWire {
  return {
    migrations: {
      applied: [...state.migrations.applied],
      ...(state.migrations.lastAppliedAt === undefined
        ? {}
        : { lastAppliedAt: state.migrations.lastAppliedAt }),
    },
    schema: {
      matches: state.schema.matches,
      undeclared: [...state.schema.undeclared],
      missing: [...state.schema.missing],
    },
    outbox: {
      depths: state.outbox.depths.map((depth) => ({
        state: depth.state,
        count: depth.count,
        ...(depth.oldestAgeSeconds === undefined
          ? {}
          : { oldestAgeSeconds: depth.oldestAgeSeconds }),
      })),
      unresolved: state.outbox.unresolved,
    },
    inbox: {
      unprocessed: state.inbox.unprocessed,
      ...(state.inbox.oldestUnprocessedAgeSeconds === undefined
        ? {}
        : {
            oldestUnprocessedAgeSeconds:
              state.inbox.oldestUnprocessedAgeSeconds,
          }),
      rejectedSignatures: state.inbox.rejectedSignatures,
    },
  };
}

function toCallSummaryWire(call: RecordedCall): ProviderCallSummaryWire {
  return {
    id: call.id,
    providerId: call.providerId,
    operation: call.operation,
    correlationId: call.correlationId,
    idempotencyId: call.idempotencyId,
    // Narrowed here rather than in persistence: the column is a text column
    // with a CHECK constraint, and the wire type is the closed set. The cast
    // is where those two meet, and it is one place rather than every reader.
    outcome: call.outcome as ProviderCallSummaryWire["outcome"],
    responseStatus: call.responseStatus,
    startedAt: formatInstant(fromJsDate(call.startedAt)),
    durationMs: call.durationMs,
  };
}

function operator(request: RequestWithPrincipal): {
  tenantId: string;
  actor: { operatorId: string };
} {
  const principal = principalOf(request);
  /* c8 ignore next 3 -- OperatorSessionGuard has already refused this case */
  if (principal?.operatorId === undefined) {
    throw new NotFoundException();
  }
  return {
    tenantId: principal.tenantId,
    actor: { operatorId: principal.operatorId },
  };
}

function pageSize(raw: string | undefined): number {
  const parsed = Number(raw ?? DEFAULT_PAGE);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_PAGE;
  }
  return Math.min(parsed, MAX_PAGE);
}

function toAccountWire(view: OperatorAccountView): AccountWire {
  const { account } = view;
  return {
    accountReference: account.accountReference,
    providerId: account.providerId,
    product: account.product,
    currency: account.currency,
    status: account.status,
    statusReason: account.statusReason,
    iban: account.iban,
    accountNumber: account.accountNumber,
    sortCode: account.sortCode,
    bic: account.bic,
    openedAt:
      account.openedAt === null
        ? null
        : formatInstant(fromJsDate(account.openedAt)),
    balance: toBalanceWire(view.balance),
  };
}

function toTransactionWire(
  transaction: ProjectedTransaction,
  accountReference: string,
): TransactionWire {
  return {
    transactionReference: transaction.transactionReference,
    accountReference,
    direction: transaction.direction,
    amount: fromMoney(transaction.amount),
    status: transaction.status,
    counterpartyName: transaction.counterpartyName,
    narrative: transaction.narrative,
    occurredAt: formatInstant(transaction.occurredAt),
  };
}
