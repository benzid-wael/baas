import type { Clock, IdGenerator } from "@baas/domain";
import { DeliveryPlanner } from "./delivery.js";
import type {
  Credentials,
  DeliveryTarget,
  ScheduledDelivery,
  SignedRequest,
} from "./delivery.js";
import { RequestLog } from "./request-log.js";
import { BASELINE_ROUTES, matchRoute } from "./routes.js";
import type { SimRoute } from "./routes.js";
import { DEFAULT_SCENARIO, isDeliveryMode } from "./scenario.js";
import type { Scenario } from "./scenario.js";
import { signKeel, signRuya, signatureMatches } from "./signing.js";

export interface SimulatorOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly credentials: Credentials;
  /** Where webhooks are delivered. Absent means deliveries are planned but not sent. */
  readonly targets?: Readonly<Partial<Record<"keel" | "ruya", string>>>;
  readonly routes?: readonly SimRoute[];
  readonly scenario?: Scenario;
}

export interface HandledRequest {
  readonly status: number;
  readonly body: unknown;
  /** Signed and ready to send; the caller decides when, per `dueAt`. */
  readonly deliveries: readonly {
    readonly due: ScheduledDelivery;
    readonly request: SignedRequest;
  }[];
}

/**
 * The simulator core: routing, signature verification, response, and the
 * webhook deliveries that follow. No sockets and no timers, so every scenario
 * is exercised by a synchronous test.
 */
export class Simulator {
  readonly log: RequestLog;
  private readonly planner: DeliveryPlanner;
  private readonly routes: readonly SimRoute[];
  private scenario: Scenario;

  constructor(private readonly options: SimulatorOptions) {
    this.log = new RequestLog(options.clock);
    this.planner = new DeliveryPlanner(
      options.clock,
      options.ids,
      options.credentials,
    );
    this.routes = options.routes ?? BASELINE_ROUTES;
    this.scenario = options.scenario ?? DEFAULT_SCENARIO;
  }

  /** Change behaviour at runtime, so a test or a developer can provoke a case. */
  setScenario(mode: string, delay?: Scenario["delay"]): Scenario {
    if (!isDeliveryMode(mode)) {
      throw new UnknownScenarioError(mode);
    }
    this.scenario = { mode, delay: delay ?? this.scenario.delay };
    return this.scenario;
  }

  currentScenario(): Scenario {
    return this.scenario;
  }

  handle(
    method: string,
    path: string,
    headers: Readonly<Record<string, string>>,
    rawBody: string,
    query: Readonly<Record<string, string>> = {},
  ): HandledRequest {
    const matched = matchRoute(this.routes, method, path);
    if (matched === undefined) {
      this.log.record({
        direction: "inbound",
        method,
        path,
        status: 404,
        signatureValid: undefined,
        body: rawBody,
      });
      return { status: 404, body: { error: "no such route" }, deliveries: [] };
    }

    const { route, params } = matched;
    let signatureValid: boolean | undefined;
    if (route.signed) {
      signatureValid = this.verifyInbound(route, headers, rawBody);
      if (!signatureValid) {
        this.log.record({
          direction: "inbound",
          method,
          path,
          status: 401,
          signatureValid,
          body: rawBody,
        });
        return {
          status: 401,
          body: { error: "invalid signature" },
          deliveries: [],
        };
      }
    }

    const result = route.handle({
      method,
      path,
      params,
      query,
      headers,
      rawBody,
      scenario: this.scenario,
    });

    this.log.record({
      direction: "inbound",
      method,
      path,
      status: result.status,
      signatureValid,
      body: rawBody,
    });

    if (result.accepted === undefined) {
      return { status: result.status, body: result.body, deliveries: [] };
    }

    const target = this.targetFor(route.provider);
    if (target === undefined) {
      return { status: result.status, body: result.body, deliveries: [] };
    }

    const deliveries = this.planner
      .plan(
        this.scenario,
        result.accepted.reference,
        result.accepted.eventType,
        result.accepted.states,
      )
      .map((due) => ({ due, request: this.planner.sign(target, due) }));

    return { status: result.status, body: result.body, deliveries };
  }

  private targetFor(provider: "keel" | "ruya"): DeliveryTarget | undefined {
    const url = this.options.targets?.[provider];
    return url === undefined ? undefined : { url, provider };
  }

  private verifyInbound(
    route: SimRoute,
    headers: Readonly<Record<string, string>>,
    rawBody: string,
  ): boolean {
    if (route.provider === "ruya") {
      return signatureMatches(
        headers["x-ruya-callback-signature"],
        signRuya(rawBody, this.options.credentials.ruyaSecret),
      );
    }
    // Keel signs `${rawBody}${idempotencyId}`, so a replayed body under a
    // different idempotency key carries an invalid signature.
    const idempotencyId = headers["x-idempotency-id"] ?? "";
    return signatureMatches(
      headers["x-digital-signature"],
      signKeel(
        rawBody,
        this.options.credentials.keelPrivateKeyPem,
        idempotencyId,
      ),
    );
  }
}

export class UnknownScenarioError extends Error {
  readonly code = "provider_sim.unknown_scenario";

  constructor(readonly mode: string) {
    super(`Unknown delivery scenario: ${JSON.stringify(mode)}`);
    this.name = "UnknownScenarioError";
  }
}
