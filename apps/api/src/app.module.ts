import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, Reflector } from "@nestjs/core";
import type { DynamicModule } from "@nestjs/common";
import type { Logger } from "@baas/platform";
import {
  ApiClientGuard,
  AuthorizationPolicyGuard,
  RolesGuard,
  SessionGuard,
  UserUuidResolverGuard,
} from "./guards.js";
import type { ApiClientLookup, CustomerLookup } from "./guards.js";
import type { AssertionConfig } from "./assertion.js";
import {
  CAPABILITY_PROVIDER,
  SystemController,
  UnguardedController,
} from "./system.controller.js";
import type { CapabilityProvider } from "./system.controller.js";
import {
  MobileReadController,
  READ_ACCOUNTS,
  READ_TRANSACTIONS,
} from "./mobile.controller.js";
import {
  OPERATOR_READS,
  PlatformReadController,
  SYSTEM_READS,
} from "./platform.controller.js";
import {
  OPERATOR_SESSIONS,
  OperatorSessionController,
} from "./operator-session.controller.js";
import type { OperatorSessionDeps } from "./operator-session.controller.js";
import { OperatorSessionGuard } from "./operator-guard.js";
import type {
  OperatorReads,
  ReadAccounts,
  ReadTransactions,
  SystemReads,
} from "@baas/application";
import type { Inbox } from "@baas/persistence";
import type { WebhookVerifier } from "@baas/domain";
import {
  WEBHOOK_INBOX,
  WEBHOOK_VERIFIER,
  WebhookController,
} from "./webhook.controller.js";
import { WebhookBodyFilter } from "./webhook-body.filter.js";

/** Inbound provider callbacks. Supplied by the composition root. */
export interface WebhookIngress {
  readonly inbox: Inbox;
  readonly verifier: WebhookVerifier;
}

/** The read surfaces. Supplied by the composition root; see the note below. */
export interface ReadSurfaces {
  readonly accounts: ReadAccounts;
  readonly transactions: ReadTransactions;
  readonly operator: OperatorReads;
  readonly system: SystemReads;
}

export interface ApiDependencies {
  readonly clients: ApiClientLookup;
  readonly customers: CustomerLookup;
  readonly assertion: AssertionConfig;
  readonly capabilities: CapabilityProvider;
  readonly logger: Logger;
  /**
   * The customer and operator read surfaces.
   *
   * Optional **only** so that a test can mount the guard chain over the system
   * controller alone, which needs no database. The composition root always
   * supplies them, and a module built without them is a smaller application
   * than the one that is deployed — so no route-coverage claim may be made
   * against it. The whole-application test in `apps/e2e` is where that claim
   * is checked, and it passes the full set.
   */
  readonly reads?: ReadSurfaces;
  /** Operator sign-in. Same rule as `reads`. */
  readonly operatorSessions?: OperatorSessionDeps;
  /** Webhook ingress. Same rule as `reads`. */
  readonly webhooks?: WebhookIngress;
  /** Test-only: mounts a controller that declares no policy, to prove refusal. */
  readonly mountUnguardedProbe?: boolean;
}

/**
 * Guard order is the contract, and it is declared once, here.
 *
 *   1 ApiClientGuard          authenticate the caller, resolve its tenant
 *   2 UserUuidResolverGuard   resolve a forwarded identity, mobile routes only
 *   2b OperatorSessionGuard   resolve an operator session, operator routes only
 *   3 SessionGuard            a principal must exist by now
 *   4 RolesGuard              role check
 *   5 AuthorizationPolicyGuard a route with no policy is refused
 *
 * Nest applies `APP_GUARD` providers in registration order, so the sequence
 * above is the sequence below. Reordering them is a security change and
 * should read like one.
 *
 * Step 2b sits beside 2 rather than replacing it because the two resolve
 * different principals on disjoint route sets: a forwarded end-user identity
 * on `@MobileSurface()`, an operator session on `@OperatorSurface()`. Both run
 * before 3, which is where "authenticated" stops being an assumption.
 */
@Module({})
export class AppModule {
  static withDependencies(deps: ApiDependencies): DynamicModule {
    const reads = deps.reads;
    const sessions = deps.operatorSessions;
    const webhooks = deps.webhooks;
    return {
      module: AppModule,
      controllers: [
        SystemController,
        ...(reads === undefined
          ? []
          : [MobileReadController, PlatformReadController]),
        ...(sessions === undefined ? [] : [OperatorSessionController]),
        ...(webhooks === undefined ? [] : [WebhookController]),
        ...(deps.mountUnguardedProbe === true ? [UnguardedController] : []),
      ],
      providers: [
        { provide: CAPABILITY_PROVIDER, useValue: deps.capabilities },
        ...(reads === undefined
          ? []
          : [
              { provide: READ_ACCOUNTS, useValue: reads.accounts },
              { provide: READ_TRANSACTIONS, useValue: reads.transactions },
              { provide: OPERATOR_READS, useValue: reads.operator },
              { provide: SYSTEM_READS, useValue: reads.system },
            ]),
        ...(sessions === undefined
          ? []
          : [{ provide: OPERATOR_SESSIONS, useValue: sessions }]),
        ...(webhooks === undefined
          ? []
          : [
              { provide: WEBHOOK_INBOX, useValue: webhooks.inbox },
              { provide: WEBHOOK_VERIFIER, useValue: webhooks.verifier },
              // Global because the body parser throws before routing, so a
              // controller-scoped filter never runs. It narrows itself to
              // `POST /webhooks/:provider` and passes everything else through
              // unchanged. See New-22.
              {
                provide: APP_FILTER,
                useFactory: () =>
                  new WebhookBodyFilter(
                    webhooks.inbox,
                    webhooks.verifier,
                    deps.logger,
                  ),
              },
            ]),
        {
          provide: APP_GUARD,
          inject: [Reflector],
          useFactory: (reflector: Reflector) =>
            new ApiClientGuard(reflector, deps.clients, deps.logger),
        },
        {
          provide: APP_GUARD,
          inject: [Reflector],
          useFactory: (reflector: Reflector) =>
            new UserUuidResolverGuard(
              reflector,
              deps.customers,
              deps.assertion,
              deps.logger,
            ),
        },
        ...(sessions === undefined
          ? []
          : [
              {
                provide: APP_GUARD,
                inject: [Reflector],
                useFactory: (reflector: Reflector) =>
                  new OperatorSessionGuard(
                    reflector,
                    sessions.db,
                    sessions.operators,
                    deps.logger,
                  ),
              },
            ]),
        {
          provide: APP_GUARD,
          inject: [Reflector],
          useFactory: (reflector: Reflector) => new SessionGuard(reflector),
        },
        {
          provide: APP_GUARD,
          inject: [Reflector],
          useFactory: (reflector: Reflector) => new RolesGuard(reflector),
        },
        {
          provide: APP_GUARD,
          inject: [Reflector],
          useFactory: (reflector: Reflector) =>
            new AuthorizationPolicyGuard(reflector, deps.logger),
        },
      ],
    };
  }
}
