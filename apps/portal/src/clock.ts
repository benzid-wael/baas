/**
 * The browser's clock boundary (finding B4).
 *
 * The rule is that nothing reads the wall clock except one named file, so that
 * anything depending on time can be tested without waiting for it. On the
 * service side that file is `packages/platform/src/clock.ts`, and its `Clock`
 * port cannot be imported here: `@baas/platform` runs on Node, and the
 * boundary gate refuses a browser package importing what does not run in a
 * browser. So this side needs its own one permitted place, and this is it.
 * `eslint.config.mjs` names it; every other file in the portal is refused.
 *
 * A function rather than a `Clock` object, because the only question the
 * browser asks is "what time is it, in milliseconds". Two numbers subtract
 * more legibly than two `Date`s, and a countdown is a subtraction.
 */
export type Now = () => number;

/** The real clock. Injected everywhere, so nothing has to wait to be tested. */
export const systemNow: Now = () => Date.now();

/**
 * An ISO instant as epoch milliseconds, or `NaN` when it is not one.
 *
 * The API's instants are strings on the wire and a string from a network
 * response is input: `NaN` is a value callers must handle, not an impossible
 * case.
 */
export function instantToMillis(iso: string): number {
  return Date.parse(iso);
}
