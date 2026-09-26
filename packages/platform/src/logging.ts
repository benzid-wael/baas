import { pino } from "pino";
import type { DestinationStream, Logger, LoggerOptions } from "pino";
import { describeError } from "./errors.js";

/**
 * Fields a log record may carry.
 *
 * An allow-list, not a redaction list. A redaction list protects only the
 * field names somebody remembered; an allow-list means a field nobody has
 * considered is dropped by default, which is the correct direction for a
 * service holding identity documents, account numbers and phone numbers.
 *
 * What is on the list is deliberately narrow: correlation, pseudonymous
 * references, state, and errors. No name, contact detail, account identifier
 * or document number appears here, and none should be added — if a diagnosis
 * seems to need one, the provider request log (RFC-BaaS §5.11) is the surface
 * that holds it, under its own retention and access audit.
 */
export const ALLOWED_LOG_FIELDS: ReadonlySet<string> = new Set([
  "correlationId",
  "requestId",
  "traceId",
  "spanId",
  "tenantId",
  "customerId",
  "actorId",
  "apiClientId",
  "accountId",
  "beneficiaryId",
  "instructionId",
  "paymentOrderId",
  "effectId",
  "corridorId",
  "ruleId",
  "providerId",
  "operationId",
  "providerRef",
  "idempotencyKey",
  "outcome",
  "state",
  "attempts",
  "durationMs",
  "statusCode",
  "method",
  "route",
  "currency",
  "amountMinorUnits",
  "err",
]);

/** Keys are reported when dropped; values never are. */
export const DROPPED_FIELDS_KEY = "droppedFields";

const MAX_FILTER_DEPTH = 4;

/**
 * What replaces a structure nested deeper than the filter will walk.
 *
 * The direction matters: passing a deep value through unfiltered would make
 * nesting a way around the allow-list, so the limit drops rather than admits.
 * Deny by default applies to logging too.
 */
export const DEPTH_LIMIT_MARKER = "<omitted: nesting depth>";

export interface LoggerConfig {
  readonly service: string;
  readonly environment: string;
  readonly level?: LoggerOptions["level"];
  /** Additional permitted field names, for a module with its own vocabulary. */
  readonly additionalFields?: readonly string[];
  /** Test seam. Production passes nothing and pino writes to stdout. */
  readonly destination?: DestinationStream;
}

export function createLogger(config: LoggerConfig): Logger {
  const allowed = new Set([
    ...ALLOWED_LOG_FIELDS,
    ...(config.additionalFields ?? []),
  ]);

  const options: LoggerOptions = {
    level: config.level ?? "info",
    base: { service: config.service, environment: config.environment },
    serializers: {
      err: (error: unknown) => describeError(error),
    },
    formatters: {
      log: (object) => filterToAllowList(object, allowed, 0),
    },
  };

  return config.destination === undefined
    ? pino(options)
    : pino(options, config.destination);
}

/**
 * Filter a log payload to permitted fields, recursively.
 *
 * Recursion matters: a permitted field whose value is an object would
 * otherwise smuggle anything at all past the list. `err` is exempt because it
 * is produced by our own serializer and its shape is known.
 */
function filterToAllowList(
  object: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  depth: number,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(object)) {
    if (!allowed.has(key)) {
      dropped.push(key);
      continue;
    }
    // `err` is exempt: it is produced by our own serializer and its shape is
    // known, so filtering it would strip the stack rather than protect anything.
    kept[key] = key === "err" ? value : filterValue(value, allowed, depth + 1);
  }

  if (dropped.length > 0) {
    kept[DROPPED_FIELDS_KEY] = dropped.sort((left, right) =>
      left.localeCompare(right),
    );
  }

  return kept;
}

function filterValue(
  value: unknown,
  allowed: ReadonlySet<string>,
  depth: number,
): unknown {
  const isStructure = Array.isArray(value) || isPlainObject(value);
  if (isStructure && depth > MAX_FILTER_DEPTH) {
    return DEPTH_LIMIT_MARKER;
  }
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => filterValue(entry, allowed, depth));
  }
  if (isPlainObject(value)) {
    return filterToAllowList(value, allowed, depth);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
