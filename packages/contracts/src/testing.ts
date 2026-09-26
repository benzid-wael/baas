import type { z } from "zod";

/**
 * Assert that a value survives the trip to storage or the wire and back.
 *
 * Review finding E5: a JSONB round-trip defect reached production paths
 * because nothing asserted that what was stored could be read back as the same
 * thing. RFC-BaaS §9 makes this assertion mandatory for every type persisted
 * as JSON; this is the helper that makes it one line.
 *
 * `JSON.parse(JSON.stringify(x))` is the honest stand-in for both a JSONB
 * column and an HTTP body: it is exactly the set of transformations both
 * apply — dropped `undefined`, `Date` becoming a string, `bigint` throwing.
 */
export interface RoundTripFailure {
  readonly reason: string;
  readonly original: unknown;
  readonly restored?: unknown;
}

export function roundTrip<T extends z.ZodType>(
  schema: T,
  value: z.infer<T>,
):
  | { ok: true; restored: z.infer<T> }
  | { ok: false; failure: RoundTripFailure } {
  const parsedOriginal = schema.safeParse(value);
  if (!parsedOriginal.success) {
    return {
      ok: false,
      failure: {
        reason: `the value does not satisfy its own schema: ${parsedOriginal.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
        original: value,
      },
    };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(parsedOriginal.data);
  } catch (error) {
    return {
      ok: false,
      failure: {
        reason: `not serialisable: ${error instanceof Error ? error.message : "unknown"}`,
        original: value,
      },
    };
  }

  const restored: unknown = JSON.parse(serialized);
  const parsedRestored = schema.safeParse(restored);
  if (!parsedRestored.success) {
    return {
      ok: false,
      failure: {
        reason: `does not satisfy its schema after a round trip: ${parsedRestored.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
        original: value,
        restored,
      },
    };
  }

  if (JSON.stringify(parsedRestored.data) !== serialized) {
    return {
      ok: false,
      failure: {
        reason: "differs from the original after a round trip",
        original: value,
        restored: parsedRestored.data,
      },
    };
  }

  return { ok: true, restored: parsedRestored.data };
}

/** Throwing form, for use directly inside a test. */
export function assertRoundTrip<T extends z.ZodType>(
  schema: T,
  value: z.infer<T>,
): z.infer<T> {
  const result = roundTrip(schema, value);
  if (!result.ok) {
    throw new Error(
      `Round trip failed: ${result.failure.reason}\n  original: ${JSON.stringify(result.failure.original)}\n  restored: ${JSON.stringify(result.failure.restored)}`,
    );
  }
  return result.restored;
}
