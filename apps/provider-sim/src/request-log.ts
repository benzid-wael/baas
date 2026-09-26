import type { Clock, Instant } from "@baas/domain";
import { formatInstant } from "@baas/platform";

/**
 * Every request and every delivery attempt, kept in memory and readable over
 * HTTP.
 *
 * Review finding C4: `keel_request_log` was the only reason several failures
 * were explicable, and it should be treated as a first-class operator surface
 * rather than an implementation detail. The simulator earns the same property
 * cheaply — when an adapter cannot authenticate, the answer is here rather
 * than in a partner's support queue.
 */
export interface LoggedRequest {
  readonly at: Instant;
  readonly direction: "inbound" | "outbound";
  readonly method: string;
  readonly path: string;
  readonly status: number | undefined;
  readonly signatureValid: boolean | undefined;
  readonly body: string;
}

export interface LogView {
  readonly at: string;
  readonly direction: "inbound" | "outbound";
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly signatureValid: boolean | null;
  readonly body: string;
}

export class RequestLog {
  private readonly entries: LoggedRequest[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly limit = 500,
  ) {}

  record(entry: Omit<LoggedRequest, "at">): void {
    this.entries.push({ ...entry, at: this.clock.now() });
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
  }

  all(): readonly LoggedRequest[] {
    return [...this.entries];
  }

  view(): readonly LogView[] {
    return this.entries.map((entry) => ({
      at: formatInstant(entry.at),
      direction: entry.direction,
      method: entry.method,
      path: entry.path,
      status: entry.status ?? null,
      signatureValid: entry.signatureValid ?? null,
      body: entry.body,
    }));
  }

  clear(): void {
    this.entries.length = 0;
  }
}
