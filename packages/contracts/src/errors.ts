import { z } from "zod";

/**
 * The error envelope. Every non-2xx response has this shape, with no
 * exceptions and no per-endpoint variants.
 *
 * `code` is the contract; `message` is not. A client switches on `code`, which
 * is stable and machine-readable, and shows `message` only to a human. The
 * incumbent returns several error shapes depending on which layer failed,
 * which is why clients there parse message text.
 */
export const errorDetailSchema = z.object({
  /** Dotted path into the request, e.g. `destination.iban`. */
  path: z.string(),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  code: z
    .string()
    .regex(
      /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/,
      "must be a dotted lower-case code, e.g. domain.money.currency_mismatch",
    ),
  message: z.string(),
  /**
   * Echoed from the request, or generated. Always present, because the first
   * question about any failure is "which request was this".
   */
  correlationId: z.string().min(1),
  details: z.array(errorDetailSchema).optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type ErrorDetail = z.infer<typeof errorDetailSchema>;
