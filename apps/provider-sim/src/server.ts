import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Duration } from "@baas/domain";
import type { Logger } from "@baas/platform";
import { describeError } from "@baas/platform";
import type { Simulator } from "./simulator.js";
import type { SignedRequest } from "./delivery.js";

export interface ServerOptions {
  readonly simulator: Simulator;
  readonly logger: Logger;
  /** Injected so tests can assert what would be sent without a socket. */
  readonly send?: (request: SignedRequest) => Promise<void>;
}

/**
 * A plain `node:http` server.
 *
 * No framework on purpose: the API application has not chosen its HTTP stack
 * yet (T8), and a development tool should not make that decision on its
 * behalf, nor pull a framework into a package that exists to be simple.
 */
export function createSimulatorServer(options: ServerOptions): Server {
  const send = options.send ?? deliver(options.logger);

  return createServer((request, response) => {
    void handle(request, response, options, send);
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions,
  send: (signed: SignedRequest) => Promise<void>,
): Promise<void> {
  const { simulator, logger } = options;
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";
  const rawBody = await readBody(request);

  // Control surface, kept under /_sim so it can never collide with a
  // partner's own path space.
  if (url.pathname === "/_sim/log") {
    json(response, 200, simulator.log.view());
    return;
  }
  if (url.pathname === "/_sim/scenario") {
    if (method === "POST") {
      applyScenario(simulator, rawBody, response);
    } else {
      const scenario = simulator.currentScenario();
      json(response, 200, {
        mode: scenario.mode,
        delayMs: scenario.delay.milliseconds,
      });
    }
    return;
  }

  const result = simulator.handle(
    method,
    url.pathname,
    headersOf(request),
    rawBody,
    Object.fromEntries(url.searchParams),
  );

  json(response, result.status, result.body);

  for (const delivery of result.deliveries) {
    schedule(delivery.due.afterMs, async () => {
      try {
        await send(delivery.request);
        logger.info(
          {
            providerRef: delivery.due.envelope.reference,
            state: delivery.due.envelope.state,
          },
          "simulated webhook delivered",
        );
      } catch (error) {
        logger.error(
          {
            err: describeError(error),
            providerRef: delivery.due.envelope.reference,
          },
          "simulated webhook delivery failed",
        );
      }
    });
  }
}

function applyScenario(
  simulator: Simulator,
  rawBody: string,
  response: ServerResponse,
): void {
  let parsed: { mode?: unknown; delayMs?: unknown };
  try {
    parsed = JSON.parse(rawBody === "" ? "{}" : rawBody) as typeof parsed;
  } catch (error) {
    json(response, 400, { error: describeError(error).message });
    return;
  }
  if (typeof parsed.mode !== "string") {
    json(response, 400, { error: "mode is required" });
    return;
  }
  try {
    const scenario = simulator.setScenario(
      parsed.mode,
      typeof parsed.delayMs === "number"
        ? Duration.ofMilliseconds(parsed.delayMs)
        : undefined,
    );
    json(response, 200, {
      mode: scenario.mode,
      delayMs: scenario.delay.milliseconds,
    });
  } catch (error) {
    json(response, 400, { error: describeError(error).message });
  }
}

function deliver(logger: Logger): (signed: SignedRequest) => Promise<void> {
  return async (signed) => {
    const response = await fetch(signed.url, {
      method: "POST",
      headers: { ...signed.headers },
      body: signed.body,
    });
    if (!response.ok) {
      logger.warn(
        { statusCode: response.status, route: signed.url },
        "webhook receiver rejected a simulated delivery",
      );
    }
  };
}

function schedule(delayMs: number, run: () => Promise<void>): void {
  const timer = setTimeout(() => {
    void run();
  }, delayMs);
  // Never hold the process open for a pending webhook.
  timer.unref();
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function headersOf(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers[name.toLowerCase()] = value;
    }
  }
  return headers;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload).toString(),
  });
  response.end(payload);
}
