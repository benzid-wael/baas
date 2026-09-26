import { DomainError } from "@baas/domain";

export interface ErrorDescription {
  readonly name: string;
  readonly code: string | undefined;
  readonly message: string;
  readonly stack: string | undefined;
  readonly cause: ErrorDescription | undefined;
}

const MAX_CAUSE_DEPTH = 4;

/**
 * Turn anything thrown into a structured, loggable description.
 *
 * Review finding B5: 110 silent catch blocks, roughly 30 with empty or
 * comment-only bodies, and four incidents in a single week prolonged by a
 * discarded error. The lint rule bans the empty body; this function removes
 * the excuse for it, so that the sanctioned handling of an error you are not
 * resolving is one line:
 *
 * ```ts
 * catch (error) {
 *   logger.error({ err: describeError(error) }, "provider dispatch failed");
 *   throw error;
 * }
 * ```
 *
 * Non-Error values are described rather than coerced, because `String(thrown)`
 * on an object yields "[object Object]" and loses the only evidence there was.
 */
export function describeError(error: unknown, depth = 0): ErrorDescription {
  if (error instanceof Error) {
    const code = error instanceof DomainError ? error.code : readCode(error);
    return {
      name: error.name,
      code,
      message: error.message,
      stack: error.stack,
      cause:
        error.cause !== undefined && depth < MAX_CAUSE_DEPTH
          ? describeError(error.cause, depth + 1)
          : undefined,
    };
  }

  return {
    name: typeof error,
    code: undefined,
    message: safeStringify(error),
    stack: undefined,
    cause: undefined,
  };
}

/** Many library errors carry a string `code` (Node system errors, pg, axios). */
function readCode(error: Error): string | undefined {
  const candidate: unknown = (error as unknown as Record<string, unknown>)[
    "code"
  ];
  return typeof candidate === "string" ? candidate : undefined;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    // Typed as `string`, but genuinely returns undefined for a top-level
    // undefined, function or symbol.
    const json = JSON.stringify(value) as string | undefined;
    return json ?? `<${typeof value}>`;
  } catch (error) {
    return `<unserialisable ${typeof value}: ${
      error instanceof Error ? error.name : "unknown"
    }>`;
  }
}
