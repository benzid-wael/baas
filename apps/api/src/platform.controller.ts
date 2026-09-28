import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
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
  ApiClientListWire,
  ScopeHistoryWire,
  SystemStateWire,
  TransactionWire,
} from "@baas/contracts";
import { KNOWN_SCOPES } from "@baas/contracts";
import type {
  ApiClientAdmin,
  OperatorAccountView,
  OperatorReads,
  SystemReads,
  SystemState,
} from "@baas/application";
import { ApiClientNotFoundError } from "@baas/application";
import { ScopeAlreadyGrantedError } from "@baas/persistence";
import type { ProjectedTransaction, RecordedCall } from "@baas/persistence";
import { formatInstant, fromJsDate } from "@baas/platform";
import { OperatorSurface, Roles } from "./decorators.js";
import { toBalanceWire } from "./wire.js";
import { principalOf } from "./principal.js";
import type { RequestWithPrincipal } from "./principal.js";

export const OPERATOR_READS = "baas:OperatorReads";
export const SYSTEM_READS = "baas:SystemReads";
export const API_CLIENT_ADMIN = "baas:ApiClientAdmin";

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
    @Inject(API_CLIENT_ADMIN) private readonly apiClients: ApiClientAdmin,
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
    @Query("accountReference") accountReference?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ): Promise<ProviderCallPageWire> {
    const { tenantId, actor } = operator(request);
    const page = await this.reads.providerCalls(tenantId, actor, {
      limit: pageSize(limit),
      providerId,
      correlationId,
      accountReference,
      cursor,
    });
    return {
      items: page.calls.map(toCallSummaryWire),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  /**
   * The tenant's API clients, with the scopes each holds today (MP-3).
   *
   * Findings D2 and F2 are two halves of one defect and fixing either alone
   * reproduces it. The incumbent's `PATCH` replaces the scope array wholesale
   * and writes no audit row; its portal cannot edit scopes at all, so the
   * changes are made directly in the database, where there is certainly no
   * audit row. An editor without the audit would just move the unaudited
   * change into the console.
   *
   * **There is no route here that takes a list of scopes.** One at a time,
   * with a reason.
   */
  @Get("api-clients")
  @OperatorSurface()
  @Roles("operator", "admin")
  async apiClientList(
    @Req() request: RequestWithPrincipal,
  ): Promise<ApiClientListWire> {
    const { tenantId } = operator(request);
    const clients = await this.apiClients.list(tenantId);
    return {
      clients: clients.map((client) => ({
        id: client.id,
        clientId: client.clientId,
        name: client.name,
        disabled: client.disabled,
        createdAt: formatInstant(fromJsDate(client.createdAt)),
        liveScopes: [...client.liveScopes],
      })),
    };
  }

  /** Every grant this client has ever had. Revoked ones stay. */
  @Get("api-clients/:id/scopes")
  @OperatorSurface()
  @Roles("operator", "admin")
  async scopeHistory(
    @Req() request: RequestWithPrincipal,
    @Param("id") id: string,
  ): Promise<ScopeHistoryWire> {
    const { tenantId } = operator(request);
    return {
      grants: (
        await notFoundIfMissing(() => this.apiClients.history(tenantId, id))
      ).map((grant) => ({
        id: grant.id,
        scope: grant.scope,
        grantedAt: formatInstant(fromJsDate(grant.grantedAt)),
        grantedBy: grant.grantedBy,
        revokedAt:
          grant.revokedAt === null
            ? null
            : formatInstant(fromJsDate(grant.revokedAt)),
        revokedBy: grant.revokedBy,
        reason: grant.reason,
        live: grant.revokedAt === null,
      })),
    };
  }

  /**
   * Grant one scope.
   *
   * **`admin`, not `operator`.** Giving a credential access to customer data
   * is a privilege change, and the role that reads should not be the role that
   * widens what can be read.
   */
  @Post("api-clients/:id/scopes")
  @OperatorSurface()
  @Roles("admin")
  @HttpCode(201)
  async grantScope(
    @Req() request: RequestWithPrincipal,
    @Param("id") id: string,
    @Body() body: { scope?: unknown; reason?: unknown },
  ): Promise<{ granted: string }> {
    const { tenantId, actor } = operator(request);
    const scope = knownScope(body.scope);
    const reason = requiredReason(body.reason);

    try {
      await notFoundIfMissing(() =>
        this.apiClients.grant(tenantId, actor, {
          apiClientId: id,
          scope,
          reason,
        }),
      );
    } catch (error) {
      if (error instanceof ScopeAlreadyGrantedError) {
        // A double-click, or two operators on the same screen. Saying so is
        // more useful than silently doing nothing, which is what a wholesale
        // array replacement would have done.
        throw new ConflictException("that scope is already granted");
      }
      throw error;
    }
    return { granted: scope };
  }

  /** Revoke one scope. The grant row stays, stamped. */
  @Delete("api-clients/:id/scopes/:scope")
  @OperatorSurface()
  @Roles("admin")
  async revokeScope(
    @Req() request: RequestWithPrincipal,
    @Param("id") id: string,
    @Param("scope") scope: string,
  ): Promise<{ revoked: boolean }> {
    const { tenantId, actor } = operator(request);
    return {
      revoked: await notFoundIfMissing(() =>
        this.apiClients.revoke(tenantId, actor, id, scope),
      ),
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
/** `ApiClientNotFoundError` is a 404, and nothing else here is. */
async function notFoundIfMissing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiClientNotFoundError) {
      throw new NotFoundException("no such API client");
    }
    throw error;
  }
}

/**
 * A scope this build actually understands.
 *
 * A typo — `mobile:account` — is accepted by any string column, shows in the
 * console as granted, and grants nothing: the operator believes access was
 * given and the caller gets 403s that look like a bug somewhere else.
 */
function knownScope(value: unknown): string {
  if (
    typeof value !== "string" ||
    !(KNOWN_SCOPES as readonly string[]).includes(value)
  ) {
    throw new BadRequestException(
      `scope must be one of: ${KNOWN_SCOPES.join(", ")}`,
    );
  }
  return value;
}

/** Why, in the operator's words. The column is not nullable for this reason. */
function requiredReason(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestException("a reason is required");
  }
  return value.trim();
}

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
    capabilities: {
      service: state.capabilities.service,
      appEnv: state.capabilities.appEnv,
      tenants: [...state.capabilities.tenants],
      providers: state.capabilities.providers.map((provider) => ({
        provider: provider.provider,
        available: provider.available,
        ...(provider.reason === undefined ? {} : { reason: provider.reason }),
        operations: [...provider.operations],
      })),
      checkedAt: state.capabilities.checkedAt,
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
    accountReference: call.accountReference,
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
