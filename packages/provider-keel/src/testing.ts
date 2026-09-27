/**
 * Helpers for contract tests.
 *
 * `fetch`'s first parameter is a union whose `toString()` the linter rightly
 * distrusts, and building a JSON `Response` by hand at every call site is
 * noise. Both get solved once, here.
 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}
